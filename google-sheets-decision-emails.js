/*******************************************************
 * FINTECH Circle — Programme Decision Emails
 *
 * Replaces the n8n "sheet updated → send decision email" workflow.
 * Paste as a NEW file (DecisionEmails) beside Code.gs. No deployment needed —
 * triggers always run the latest saved code.
 *
 * Sheet:
 *   Programme Applicants
 *
 * Columns:
 *   Q = Approval          (Susanne sets this by hand)
 *   R = Email Status      (this script's audit trail — do not edit by hand)
 *
 * Decisions:
 *   Accepted
 *   Rejected
 *
 * Sender:
 *   boards@fintechcircle.com — must be a VERIFIED ALIAS of the Google account
 *   that installs the trigger. Run checkSenderAlias() before anything else.
 *
 * SETUP ORDER — the backfill is not optional:
 *   1. checkSenderAlias()
 *   2. previewDecisionEmails()
 *   3. backfillDecisionLog()     ← before step 4, or the sweep emails everyone
 *   4. installDecisionTrigger()
 *   5. installDecisionDropdown()
 *******************************************************/


const DECISION_CONFIG = {
  sheetName: 'Programme Applicants',

  // Column Q
  decisionColumn: 'Q',

  // Column R
  logColumn: 'R',

  senderName: 'FINTECH Circle',

  // Must be a verified "Send mail as" alias on the installing account, or every
  // send throws "Invalid argument: from". Set to '' to send from that account's
  // own address instead. checkSenderAlias() tells you which applies.
  fromEmail: 'boards@fintechcircle.com',

  // Optional. '' switches either off.
  bcc: '',
  replyTo: '',

  // Told when a send fails, so a broken automation is not silent. '' to switch off.
  adminEmail: 'applications@fintechcircle.com',

  // ⚠️ Leave true. Any non-empty value in column R counts as "already handled",
  // so rows the old n8n workflow already emailed — whatever wording it wrote —
  // are never emailed twice. 'FAILED …' still retries.
  //
  // false switches to matching the decision, which makes a changed decision
  // re-send. Run backfillDecisionLog() first if you enable it.
  treatAnyLogValueAsSent: true,

  acceptedSubject:
    'Your FINTECH Circle programme application — accepted',

  rejectedSubject:
    '{{First Name}}, the Board Programme is available to you online'
};


/*******************************************************
 * EMAIL SIGNATURE
 *
 * Susanne's sign-off block, appended to both emails.
 *
 * The banner is sent as an INLINE IMAGE (a real attachment referenced by
 * cid:), not a hotlink. Most mail clients block remote <img> by default, so a
 * hotlinked banner shows as a broken box until the reader clicks "display
 * images" — an inline one renders immediately.
 *
 * To set bannerDriveFileId:
 *   1. Save the banner as a file (right-click it in Susanne's signature →
 *      Save image as, or take it from fintechcircle.com).
 *   2. Upload to Google Drive, in the Drive of the account that runs the script.
 *   3. Open it and copy the id from the URL:
 *      drive.google.com/file/d/THIS_PART_HERE/view
 *
 * Leave it '' and the banner falls back to bannerUrl, or is omitted entirely
 * if that is blank too. Everything else in the signature still sends.
 *******************************************************/


const SIGNATURE_CONFIG = {
  name: 'Susanne Chishti',
  title: 'Chair | FINTECH Circle &amp; Co-Editor The FINTECH Book Series',
  subtitle: 'Investor &amp; Board Member',
  website: 'https://www.fintechcircle.com/',
  email: 'susanne.chishti@fintechcircle.com',

  // Preferred: a Drive file id, sent inline. See the note above.
  bannerDriveFileId: '',

  // Fallback only, used when bannerDriveFileId is blank. Must be a public URL.
  bannerUrl: '',

  bannerLink: 'https://fintechcircle.com/fintech-for-good/',
  bannerAlt: 'Fintech for Good — ITN Business news programme',
  bannerWidth: 500
};

// Set once per execution so a sweep sending 40 emails fetches the banner once.
let SIGNATURE_IMAGE_CACHE;


/**
 * Runs automatically when someone edits the Decision column (Q).
 *
 * IMPORTANT:
 * This function is intended to be used with an
 * INSTALLABLE onEdit trigger. A simple onEdit cannot send email.
 */
function onApplicationDecision(e) {

  if (!e || !e.range) {
    return;
  }

  const range = e.range;
  const sheet = range.getSheet();

  // Only work on the Programme Applicants sheet
  if (sheet.getName() !== DECISION_CONFIG.sheetName) {
    return;
  }

  const decisionColumnNumber =
    columnLetterToNumber(DECISION_CONFIG.decisionColumn);

  // A paste, a fill-down or a multi-cell delete covers a block of cells, not one.
  // Check whether that block includes column Q at all.
  const firstColumn = range.getColumn();
  const lastColumn = firstColumn + range.getNumColumns() - 1;

  if (decisionColumnNumber < firstColumn || decisionColumnNumber > lastColumn) {
    return;
  }

  // Process every edited row, skipping the header
  const firstRow = range.getRow();
  const lastRow = firstRow + range.getNumRows() - 1;

  for (let rowNumber = Math.max(firstRow, 2); rowNumber <= lastRow; rowNumber++) {
    try {
      processDecisionRow(sheet, rowNumber);
    } catch (error) {
      console.error('Error processing row ' + rowNumber + ': ' + error.message);
    }
  }
}


/**
 * Processes one applicant row.
 *
 * headers is optional — the sweep passes it in so the header row is read once
 * per run rather than once per applicant.
 */
function processDecisionRow(sheet, rowNumber, headers) {

  const lock = LockService.getScriptLock();

  // Prevent two executions from sending duplicate emails
  if (!lock.tryLock(10000)) {
    console.log('Could not acquire lock. Skipping row ' + rowNumber);
    return;
  }

  try {

    const lastColumn = Math.max(
      sheet.getLastColumn(),
      columnLetterToNumber(DECISION_CONFIG.logColumn)
    );

    const headerRow = headers || sheet
      .getRange(1, 1, 1, lastColumn)
      .getValues()[0];

    const row = sheet
      .getRange(rowNumber, 1, 1, lastColumn)
      .getValues()[0];

    const decisionColumnNumber =
      columnLetterToNumber(DECISION_CONFIG.decisionColumn);

    const logColumnNumber =
      columnLetterToNumber(DECISION_CONFIG.logColumn);

    const decision = String(
      row[decisionColumnNumber - 1] || ''
    ).trim();

    const existingLog = String(
      row[logColumnNumber - 1] || ''
    ).trim();

    // Only process Accepted or Rejected
    if (
      decision.toLowerCase() !== 'accepted' &&
      decision.toLowerCase() !== 'rejected'
    ) {
      return;
    }

    // Don't send again if already handled
    if (alreadyHandled(existingLog, decision)) {
      return;
    }

    // Find columns by header name
    const firstName = getValueByHeader(
      headerRow,
      row,
      'First Name'
    );

    const lastName = getValueByHeader(
      headerRow,
      row,
      'Last Name'
    );

    const email = getValueByHeader(
      headerRow,
      row,
      'Email'
    );

    if (!email) {
      sheet
        .getRange(rowNumber, logColumnNumber)
        .setValue('FAILED — no email address');

      console.log(
        'No email address found for row ' + rowNumber
      );

      return;
    }

    // Check remaining Gmail quota
    const remainingQuota = MailApp.getRemainingDailyQuota();

    if (remainingQuota <= 0) {

      sheet
        .getRange(rowNumber, logColumnNumber)
        .setValue('FAILED — daily email quota reached');

      console.log(
        'Daily email quota reached.'
      );

      return;
    }

    const applicantData = {
      firstName: firstName,
      lastName: lastName,
      email: email,
      decision: decision
    };

    // Send the appropriate email
    sendDecisionEmail(applicantData);

    // Record successful send in column R
    const normalizedDecision =
      decision.toLowerCase() === 'accepted'
        ? 'accepted'
        : 'rejected';

    sheet
      .getRange(rowNumber, logColumnNumber)
      .setValue(
        normalizedDecision +
        ' — sent ' +
        new Date().toLocaleString()
      );

    SpreadsheetApp.flush();

    console.log(
      'Decision email sent to ' +
      email +
      ' for row ' +
      rowNumber
    );

  } catch (error) {

    const logColumnNumber =
      columnLetterToNumber(DECISION_CONFIG.logColumn);

    sheet
      .getRange(rowNumber, logColumnNumber)
      .setValue(
        'FAILED — ' + error.message
      );

    console.error(error);

    notifyAdmin(
      'Decision email failed for row ' + rowNumber,
      error.message + '\n\n' + (error.stack || '')
    );

  } finally {

    lock.releaseLock();

  }
}


/**
 * The duplicate guard.
 *
 * Safe mode (treatAnyLogValueAsSent): anything already in column R means the row
 * has been dealt with, including whatever the old n8n workflow wrote there.
 * 'FAILED …' is never treated as handled, so the hourly sweep retries it.
 */
function alreadyHandled(existingLog, decision) {

  const value = String(existingLog || '').trim().toLowerCase();

  if (!value) {
    return false;
  }

  if (value.indexOf('failed') === 0) {
    return false;
  }

  if (DECISION_CONFIG.treatAnyLogValueAsSent) {
    return true;
  }

  return value.indexOf(decision.toLowerCase()) === 0;
}


/**
 * Sends the acceptance or rejection email.
 */
function sendDecisionEmail(data) {

  const firstName = data.firstName || 'Applicant';

  let subject;
  let htmlBody;
  let plainText;

  if (data.decision.toLowerCase() === 'accepted') {

    subject =
      DECISION_CONFIG.acceptedSubject;

    htmlBody = buildAcceptanceEmail(firstName);

    plainText = buildAcceptancePlainText(firstName);

  } else {

    subject =
      DECISION_CONFIG.rejectedSubject.replace(
        '{{First Name}}',
        firstName
      );

    htmlBody = buildRejectionEmail(firstName);

    plainText = buildRejectionPlainText(firstName);
  }


  // Appended here rather than inside each template, so the signature is defined
  // in exactly one place and both emails stay in step.
  htmlBody = htmlBody + buildSignatureHtml();
  plainText = plainText + '\n\n\n' + buildSignaturePlainText();

  const options = {
    htmlBody: htmlBody,
    name: DECISION_CONFIG.senderName,
    inlineImages: getSignatureInlineImages()
  };

  // Only set `from` when it is genuinely a verified alias — otherwise Gmail
  // rejects the whole send with "Invalid argument: from".
  if (DECISION_CONFIG.fromEmail) {
    options.from = DECISION_CONFIG.fromEmail;
  }

  if (DECISION_CONFIG.bcc) {
    options.bcc = DECISION_CONFIG.bcc;
  }

  if (DECISION_CONFIG.replyTo) {
    options.replyTo = DECISION_CONFIG.replyTo;
  }

  GmailApp.sendEmail(
    data.email,
    subject,
    plainText,
    options
  );
}


/*******************************************************
 * SIGNATURE BUILDERS
 *******************************************************/


/**
 * Fetches the banner from Drive once per execution.
 * Returns null when no file id is set or the fetch fails — the signature then
 * falls back to bannerUrl, and a missing banner never blocks the email.
 */
function getSignatureImageBlob() {

  if (SIGNATURE_IMAGE_CACHE !== undefined) {
    return SIGNATURE_IMAGE_CACHE;
  }

  SIGNATURE_IMAGE_CACHE = null;

  if (!SIGNATURE_CONFIG.bannerDriveFileId) {
    return SIGNATURE_IMAGE_CACHE;
  }

  try {
    SIGNATURE_IMAGE_CACHE = DriveApp
      .getFileById(SIGNATURE_CONFIG.bannerDriveFileId)
      .getBlob()
      .setName('signatureBanner');

  } catch (error) {
    console.error(
      'Could not load the signature banner from Drive: ' + error.message +
      ' — sending without it.'
    );
  }

  return SIGNATURE_IMAGE_CACHE;
}


/**
 * The inlineImages map handed to GmailApp. Empty when there is no Drive blob.
 */
function getSignatureInlineImages() {

  const blob = getSignatureImageBlob();

  return blob ? { signatureBanner: blob } : {};
}


function buildSignatureHtml() {

  const blob = getSignatureImageBlob();

  // cid: points at the inline attachment; the URL is the hotlink fallback.
  const imageSource = blob
    ? 'cid:signatureBanner'
    : SIGNATURE_CONFIG.bannerUrl;

  let bannerHtml = '';

  if (imageSource) {
    bannerHtml = `
      <p style="margin: 20px 0 8px 0;">
        <a href="${SIGNATURE_CONFIG.bannerLink}" target="_blank">
          <img
            src="${imageSource}"
            alt="${SIGNATURE_CONFIG.bannerAlt}"
            width="${SIGNATURE_CONFIG.bannerWidth}"
            style="width: 100%; max-width: ${SIGNATURE_CONFIG.bannerWidth}px; height: auto; border: 0; display: block;"
          >
        </a>
      </p>

      <p style="margin: 0;">
        <a href="${SIGNATURE_CONFIG.bannerLink}" target="_blank" style="color: #1a73e8;">
          ${SIGNATURE_CONFIG.bannerLink}
        </a>
      </p>
    `;
  }

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 1.5; color: #222; margin-top: 40px;">

      <p style="margin: 0;">
        <strong>${SIGNATURE_CONFIG.name}</strong><br>
        <strong>${SIGNATURE_CONFIG.title}</strong><br>
        ${SIGNATURE_CONFIG.subtitle}<br>
        <a href="${SIGNATURE_CONFIG.website}" target="_blank" style="color: #1a73e8;">
          ${SIGNATURE_CONFIG.website}
        </a>
      </p>

      <p style="margin: 12px 0 0 0;">
        Email:
        <a href="mailto:${SIGNATURE_CONFIG.email}" style="color: #1a73e8;">
          ${SIGNATURE_CONFIG.email}
        </a>
      </p>

      ${bannerHtml}

    </div>
  `;
}


function buildSignaturePlainText() {

  // Entities are for the HTML version; the text version wants the characters.
  const plain = function (value) {
    return String(value).replace(/&amp;/g, '&');
  };

  return `
${plain(SIGNATURE_CONFIG.name)}
${plain(SIGNATURE_CONFIG.title)}
${plain(SIGNATURE_CONFIG.subtitle)}
${SIGNATURE_CONFIG.website}

Email: ${SIGNATURE_CONFIG.email}

${SIGNATURE_CONFIG.bannerAlt}:
${SIGNATURE_CONFIG.bannerLink}
  `.trim();
}


/*******************************************************
 * ACCEPTANCE EMAIL
 *******************************************************/


function buildAcceptanceEmail(firstName) {

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #222;">

      <p>Dear ${escapeHtml(firstName)},</p>

      <p>
        Congratulations - your application to the FINTECH Circle Flagship Board Programme has been successful.
        We are delighted to offer you a place in our September 2026 cohort, starting 1 September.
      </p>

      <p>
        This cohort is highly selective, capped at 25 members.
        You'll be joining a curated group of senior executives preparing for their first or next
        Non-Executive Director appointment, alongside access to the wider FINTECH Circle community
        of 260,000+ professionals globally.
      </p>

      <p>
        Over the next three months you can look forward to:
      </p>

      <ul>
        <li>
          Monthly live webinars with NEDs, Chairs and headhunters, plus monthly Pop-Up Boards
          where you'll work live board papers with real fintech CEOs
        </li>

        <li>
          Exclusive in-person events in London, and dedicated FCA/PRA, SMCR and Consumer Duty
          regulatory deep-dives
        </li>

        <li>
          Embedded access to 8 leading board headhunter firms - Audeliss, Teneo, Warren Partners,
          Russell Reynolds, Norman Broadbent, Sapphire Partners, Sainty Hird &amp; Partners and Miles Advisory -
          including a live NED CV Clinic and a First-Time NED success session
        </li>

        <li>
          A WhatsApp peer network for real-time board and regulatory support, plus a Personal Social Media Card
          and a written interview published on FINTECH Circle LinkedIn and website
        </li>

        <li>
          A Certificate of Completion, CPD-eligible hours, and 3 months' continued community access
          after the programme ends
        </li>

        <li>
          Highlights on the calendar include our Pop-Up Board on 12 October chaired by Susanne Chishti,
          and the Annual FINTECH Circle Board &amp; CEO Summit in London on 16 November at Deloitte,
          an exclusive networking event for Fintech CEOs, their Boards, top headhunters and our Board Members.
        </li>
      </ul>

      <p>
        To confirm your place, please arrange payment of <strong>£2,950</strong> via the secure link below.
        Seats are held once payment is received:
      </p>

      <p>
        <a
          href="https://secure.fintechcirclepro.com/payment-page-flagship"
          target="_blank"
          style="color: #1a73e8;"
        >
          https://secure.fintechcirclepro.com/payment-page-flagship
        </a>
      </p>

      <p>
        We look forward to welcoming you.
      </p>

      <p>
        Best regards,<br>
        Susanne Chishti<br>
        Founder &amp; Chair, FINTECH Circle
      </p>

    </div>
  `;
}


function buildAcceptancePlainText(firstName) {

  return `
Dear ${firstName},

Congratulations - your application to the FINTECH Circle Flagship Board Programme has been successful. We are delighted to offer you a place in our September 2026 cohort, starting 1 September.

This cohort is highly selective, capped at 25 members. You'll be joining a curated group of senior executives preparing for their first or next Non-Executive Director appointment, alongside access to the wider FINTECH Circle community of 260,000+ professionals globally.

Over the next three months you can look forward to:

- Monthly live webinars with NEDs, Chairs and headhunters, plus monthly Pop-Up Boards where you'll work live board papers with real fintech CEOs
- Exclusive in-person events in London, and dedicated FCA/PRA, SMCR and Consumer Duty regulatory deep-dives
- Embedded access to 8 leading board headhunter firms - Audeliss, Teneo, Warren Partners, Russell Reynolds, Norman Broadbent, Sapphire Partners, Sainty Hird & Partners and Miles Advisory - including a live NED CV Clinic and a First-Time NED success session
- A WhatsApp peer network for real-time board and regulatory support, plus a Personal Social Media Card and a written interview published on FINTECH Circle LinkedIn and website
- A Certificate of Completion, CPD-eligible hours, and 3 months' continued community access after the programme ends
- Highlights on the calendar include our Pop-Up Board on 12 October chaired by Susanne Chishti, and the Annual FINTECH Circle Board & CEO Summit in London on 16 November at Deloitte, an exclusive networking event for Fintech CEOs, their Boards, top headhunters and our Board Members.

To confirm your place, please arrange payment of £2,950 via the secure link below. Seats are held once payment is received:

https://secure.fintechcirclepro.com/payment-page-flagship

We look forward to welcoming you.

Best regards,
Susanne Chishti
Founder & Chair, FINTECH Circle
  `.trim();
}


/*******************************************************
 * REJECTION EMAIL
 *******************************************************/


function buildRejectionEmail(firstName) {

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #222;">

      <p>Dear ${escapeHtml(firstName)},</p>

      <p>
        Thank you for your application to the live FINTECH Circle Board Programme,
        unfortunately we cannot offer you a place on the cohort at this time as places are strictly limited.
      </p>

      <p>
        The board training is also available online, with no application required.
      </p>

      <p>
        It is 12 hours of on-demand board training with a full year of access,
        taught by Patrick Dunne OBE, Susanne Chishti and other serving Chairs and NEDs.
        It covers board fundamentals and directors' duties, portfolio career strategy,
        the fintech advisory and NED landscape, regulatory accountability, and AI for board members.
        It also includes the headhunter sessions with Audeliss, Teneo, Warren Partners,
        Russell Reynolds, Norman Broadbent, Sapphire Partners and Miles Advisory,
        interviews with sitting Chairs and NEDs, and a Certificate of Completion with CPD-eligible hours.
      </p>

      <p>
        Enrol any time, start immediately, and study next to a full-time role.
      </p>

      <p>
        Enrol for <strong>£999 including VAT</strong>:
      </p>

      <p>
        <a
          href="https://secure.fintechcirclepro.com/payment-page-digital"
          target="_blank"
          style="color: #1a73e8;"
        >
          https://secure.fintechcirclepro.com/payment-page-digital
        </a>
      </p>

      <p>
        Full programme details:
        <a
          href="https://fintechcircle.com/boards-online"
          target="_blank"
          style="color: #1a73e8;"
        >
          https://fintechcircle.com/boards-online
        </a>
      </p>

      <p>
        Warm regards,<br>
        FINTECH Circle Team
      </p>

    </div>
  `;
}


function buildRejectionPlainText(firstName) {

  return `
Dear ${firstName},

Thank you for your application to the live FINTECH Circle Board Programme, unfortunately we cannot offer you a place on the cohort at this time as places are strictly limited.

The board training is also available online, with no application required.

It is 12 hours of on-demand board training with a full year of access, taught by Patrick Dunne OBE, Susanne Chishti and other serving Chairs and NEDs. It covers board fundamentals and directors' duties, portfolio career strategy, the fintech advisory and NED landscape, regulatory accountability, and AI for board members. It also includes the headhunter sessions with Audeliss, Teneo, Warren Partners, Russell Reynolds, Norman Broadbent, Sapphire Partners and Miles Advisory, interviews with sitting Chairs and NEDs, and a Certificate of Completion with CPD-eligible hours.

Enrol any time, start immediately, and study next to a full-time role.

Enrol for £999 including VAT:

https://secure.fintechcirclepro.com/payment-page-digital

Full programme details:

https://fintechcircle.com/boards-online

Warm regards,
FINTECH Circle Team
  `.trim();
}


/*******************************************************
 * CHECK SENDER ALIAS
 *
 * RUN THIS FIRST.
 *
 * GmailApp only accepts a `from` address that is a verified
 * "Send mail as" alias on the account running the script.
 * Anything else fails every single send with
 * "Invalid argument: from".
 *******************************************************/


function checkSenderAlias() {

  const account = Session.getEffectiveUser().getEmail();
  const aliases = GmailApp.getAliases();

  let message =
    'Script runs as: ' + account + '\n' +
    'Verified aliases: ' + (aliases.length ? aliases.join(', ') : '(none)') + '\n\n';

  if (!DECISION_CONFIG.fromEmail) {
    message += 'fromEmail is blank — emails will send from ' + account + '.';

  } else if (DECISION_CONFIG.fromEmail === account) {
    message += 'OK — fromEmail is the account itself.';

  } else if (aliases.indexOf(DECISION_CONFIG.fromEmail) !== -1) {
    message += 'OK — ' + DECISION_CONFIG.fromEmail + ' is a verified alias.';

  } else {
    message +=
      'PROBLEM — ' + DECISION_CONFIG.fromEmail + ' is NOT a verified alias.\n' +
      'Every send would fail with "Invalid argument: from".\n\n' +
      'Either add it in Gmail (Settings → Accounts → Send mail as → ' +
      'Add another email address, then confirm the verification email), ' +
      'or set fromEmail to \'\' to send from ' + account + '.';
  }

  console.log(message);
  return message;
}


/*******************************************************
 * PREVIEW
 *
 * Sends two test emails to the Google account running
 * the script:
 *
 * 1. Acceptance
 * 2. Rejection
 *
 * This does NOT send anything to applicants.
 *******************************************************/


function previewDecisionEmails() {

  const testEmail =
    Session.getEffectiveUser().getEmail();

  if (!testEmail) {
    throw new Error(
      'Could not determine the Google account email.'
    );
  }

  const testFirstName = 'Test';

  // Test acceptance
  sendDecisionEmail({
    firstName: testFirstName,
    lastName: 'Applicant',
    email: testEmail,
    decision: 'Accepted'
  });

  // Test rejection
  sendDecisionEmail({
    firstName: testFirstName,
    lastName: 'Applicant',
    email: testEmail,
    decision: 'Rejected'
  });

  return alertOrLog(
    'Preview emails sent to:\n\n' +
    testEmail +
    '\n\nPlease check your inbox.'
  );
}


/*******************************************************
 * BACKFILL — RUN BEFORE installDecisionTrigger()
 *
 * Every row already decided during the n8n era looks
 * "unsent" to this script. Without this, the first hourly
 * sweep emails the entire back catalogue again.
 *
 * This stamps those rows as handled and sends nothing.
 * Rows whose Email Status is already filled are untouched.
 *******************************************************/


function backfillDecisionLog() {

  const sheet =
    SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheetByName(DECISION_CONFIG.sheetName);

  if (!sheet) {
    throw new Error(
      'Sheet "' + DECISION_CONFIG.sheetName + '" was not found.'
    );
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return alertOrLog('Nothing to backfill.');
  }

  const decisionColumnNumber =
    columnLetterToNumber(DECISION_CONFIG.decisionColumn);

  const logColumnNumber =
    columnLetterToNumber(DECISION_CONFIG.logColumn);

  const decisions = sheet
    .getRange(2, decisionColumnNumber, lastRow - 1, 1)
    .getValues();

  const logs = sheet
    .getRange(2, logColumnNumber, lastRow - 1, 1)
    .getValues();

  let marked = 0;

  for (let i = 0; i < decisions.length; i++) {

    const decision = String(decisions[i][0] || '').trim().toLowerCase();

    if (decision !== 'accepted' && decision !== 'rejected') {
      continue;
    }

    if (String(logs[i][0] || '').trim()) {
      continue;
    }

    logs[i][0] = decision + ' — pre-existing, not sent by this script';
    marked++;
  }

  sheet
    .getRange(2, logColumnNumber, lastRow - 1, 1)
    .setValues(logs);

  SpreadsheetApp.flush();

  return alertOrLog(
    marked + ' already-decided row(s) marked as handled.\n\nNo emails were sent.'
  );
}


/*******************************************************
 * INSTALL DECISION DROPDOWN
 *
 * Adds:
 *   Pending
 *   Accepted
 *   Rejected
 *
 * to column Q.
 *******************************************************/


function installDecisionDropdown() {

  const sheet =
    SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheetByName(DECISION_CONFIG.sheetName);

  if (!sheet) {
    throw new Error(
      'Sheet "' +
      DECISION_CONFIG.sheetName +
      '" was not found.'
    );
  }

  const decisionColumnNumber =
    columnLetterToNumber(
      DECISION_CONFIG.decisionColumn
    );

  const rule =
    SpreadsheetApp.newDataValidation()
      .requireValueInList(
        ['Pending', 'Accepted', 'Rejected'],
        true
      )
      .setAllowInvalid(false)
      .setHelpText(
        'Set to Accepted or Rejected to send the applicant their decision email.'
      )
      .build();

  sheet
    .getRange(
      2,
      decisionColumnNumber,
      Math.max(sheet.getMaxRows() - 1, 1),
      1
    )
    .setDataValidation(rule);

  return alertOrLog(
    'Decision dropdown installed in column ' +
    DECISION_CONFIG.decisionColumn + '.'
  );
}


/*******************************************************
 * INSTALL TRIGGERS
 *
 * Installs:
 *
 * 1. Spreadsheet edit trigger
 *    → sends email when Q changes
 *
 * 2. Hourly sweep
 *    → retries decisions that may have been missed
 *
 * Run as the account the emails should come from — the
 * trigger runs as whoever installs it.
 *******************************************************/


function installDecisionTrigger() {

  // Refuse to arm the automation with a from-address Gmail will reject.
  const account = Session.getEffectiveUser().getEmail();

  if (
    DECISION_CONFIG.fromEmail &&
    DECISION_CONFIG.fromEmail !== account &&
    GmailApp.getAliases().indexOf(DECISION_CONFIG.fromEmail) === -1
  ) {
    throw new Error(
      DECISION_CONFIG.fromEmail + ' is not a verified alias on ' + account +
      '. Run checkSenderAlias() for what to do. Triggers NOT installed.'
    );
  }

  const spreadsheet =
    SpreadsheetApp.getActiveSpreadsheet();

  // Remove existing copies of these triggers
  const triggers =
    ScriptApp.getProjectTriggers();

  triggers.forEach(function(trigger) {

    const handler =
      trigger.getHandlerFunction();

    if (
      handler === 'onApplicationDecision' ||
      handler === 'sweepPendingDecisions'
    ) {
      ScriptApp.deleteTrigger(trigger);
    }

  });


  // Trigger when a spreadsheet cell is edited
  ScriptApp.newTrigger('onApplicationDecision')
    .forSpreadsheet(spreadsheet)
    .onEdit()
    .create();


  // Backup sweep every hour
  ScriptApp.newTrigger('sweepPendingDecisions')
    .timeBased()
    .everyHours(1)
    .create();


  return alertOrLog(
    'Decision email triggers installed.\n\nEmails will send as: ' +
    (DECISION_CONFIG.fromEmail || account)
  );
}


/*******************************************************
 * SWEEP
 *
 * Checks the entire sheet for Accepted/Rejected
 * decisions that have not yet been emailed.
 *
 * This acts as a backup if the edit trigger misses
 * something or if an email temporarily fails.
 *******************************************************/


function sweepPendingDecisions() {

  const sheet =
    SpreadsheetApp
      .getActiveSpreadsheet()
      .getSheetByName(DECISION_CONFIG.sheetName);

  if (!sheet) {
    console.log(
      'Sheet "' +
      DECISION_CONFIG.sheetName +
      '" not found.'
    );
    return;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return;
  }

  const lastColumn = Math.max(
    sheet.getLastColumn(),
    columnLetterToNumber(DECISION_CONFIG.logColumn)
  );

  // Read the header row once, not once per applicant.
  const headers = sheet
    .getRange(1, 1, 1, lastColumn)
    .getValues()[0];

  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber++) {

    try {
      processDecisionRow(sheet, rowNumber, headers);
    } catch (error) {
      console.error(
        'Error processing row ' +
        rowNumber +
        ': ' +
        error.message
      );
    }

  }
}


/*******************************************************
 * RESEND
 *
 * Select an applicant row and run this function.
 *
 * It clears the existing email log and sends the
 * decision email again.
 *******************************************************/


function resendDecisionForSelectedRow() {

  const sheet =
    SpreadsheetApp
      .getActiveSpreadsheet()
      .getActiveSheet();

  if (
    sheet.getName() !==
    DECISION_CONFIG.sheetName
  ) {
    throw new Error(
      'Please select a row in the "' +
      DECISION_CONFIG.sheetName +
      '" sheet.'
    );
  }

  const rowNumber =
    sheet.getActiveRange().getRow();

  if (rowNumber === 1) {
    throw new Error(
      'Please select an applicant row, not the header.'
    );
  }

  const logColumnNumber =
    columnLetterToNumber(
      DECISION_CONFIG.logColumn
    );

  // Clear the previous sent status
  sheet
    .getRange(rowNumber, logColumnNumber)
    .clearContent();

  // Process and send again
  processDecisionRow(
    sheet,
    rowNumber
  );

  return alertOrLog(
    'Decision email resend attempted for row ' +
    rowNumber +
    '.\n\nCheck column ' + DECISION_CONFIG.logColumn + ' for the result.'
  );
}


/*******************************************************
 * HELPERS
 *******************************************************/


function getValueByHeader(headers, row, headerName) {

  // Compared loosely so a stray space in the header row does not blank the field.
  const wanted = String(headerName).trim().toLowerCase();

  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i] || '').trim().toLowerCase() === wanted) {
      return row[i] || '';
    }
  }

  return '';
}


function columnLetterToNumber(letter) {

  const clean = String(letter || '').trim().toUpperCase();

  let column = 0;

  for (
    let i = 0;
    i < clean.length;
    i++
  ) {

    column =
      column * 26 +
      clean.charCodeAt(i) -
      'A'.charCodeAt(0) +
      1;

  }

  return column;
}


function escapeHtml(value) {

  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


function notifyAdmin(subject, body) {

  if (!DECISION_CONFIG.adminEmail) {
    return;
  }

  try {
    MailApp.sendEmail(
      DECISION_CONFIG.adminEmail,
      '[Automation] ' + subject,
      body
    );
  } catch (error) {
    console.error('Could not notify admin: ' + error.message);
  }
}


/**
 * Shows a dialog when there is a spreadsheet UI to show it in, and falls back to
 * the log when there is not. Run from the editor, SpreadsheetApp.getUi() throws —
 * which would otherwise make a successful run look like a failure.
 */
function alertOrLog(message) {

  console.log(message);

  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (error) {
    // No UI available (editor or trigger context). The log has it.
  }

  return message;
}
