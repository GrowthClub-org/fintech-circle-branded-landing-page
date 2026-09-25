// Google Apps Script for CISI x FINTECH Circle Board Readiness Programme applications
//
// STANDALONE. This script is bound to the CISI spreadsheet and deploys as its own
// Web App, with its own /exec URL. It does not read or write the main FINTECH
// Circle spreadsheet, and the main script does not touch this one. CISI applicants
// are therefore separable from direct applicants at the file level, which is what
// the revenue share arrangement needs.
//
// Setup:
//   1. Open the CISI spreadsheet → Extensions → Apps Script
//   2. Paste this file, save
//   3. Run setupCisiSheet() once from the editor, or use the menu after a reload
//   4. Deploy → New deployment → Web app
//        Execute as:      Me
//        Who has access:  Anyone
//   5. Put the /exec URL into CISI_SHEETS_URL in application-cisi.html
//
// ⚠️ getApplicationHeaders() must match this sheet's row 1, column for column.
// doPost only writes a header row when the tab is empty, so once the sheet holds
// data the header row is never corrected — the code would silently start writing
// rows one column out of step with the headers and with every historical row.
// To add a field: insert the column in the sheet FIRST, then add it at the matching
// position here. Appending at the end is only safe while the columns to the right
// hold nothing — here, Q and R.
//
// The column layout deliberately mirrors the main script's Programme Applicants
// tab. Keeping them identical means a CISI row can be compared with, or moved to,
// the direct sheet without remapping. If you change one, change both.

const SHEET_NAME = 'CISI Applicants';
const PROGRAMME_NAME = 'CISI x FINTECH Circle Board Readiness Programme';

// Where the team is notified. One constant, so the address cannot drift between
// the notification function and the setup log.
const APPLICATION_NOTIFICATION_EMAIL = 'applications@fintechcircle.com';

// Accepted form types. The page sends 'application-cisi'; plain 'application' is
// accepted too, so a mis-set formType on the CISI page still lands here rather
// than being written as a registration row.
const ACCEPTED_FORM_TYPES = ['application-cisi', 'application'];

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const formType = data.formType || 'application-cisi';

    // This deployment only serves the CISI application form. Anything else is a
    // misrouted request - say so rather than writing a malformed row.
    if (ACCEPTED_FORM_TYPES.indexOf(formType) === -1) {
      Logger.log('Rejected formType "' + formType + '" — this endpoint only accepts CISI applications');
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: 'This endpoint only accepts CISI applications, not "' + formType + '"'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);

    // Set up headers if the sheet is new
    if (sheet.getLastRow() === 0) {
      const headers = getApplicationHeaders();
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold')
        .setBackground('#22C1C9')
        .setFontColor('#FFFFFF')
        .setWrap(true);
    }

    const rowData = prepareApplicationRow(data);

    // Append and format under a lock. Two submissions landing in the same second
    // would otherwise both read the same getLastRow() and format each other's row.
    const lock = LockService.getScriptLock();
    const locked = lock.tryLock(30000);
    let newRow;

    try {
      sheet.appendRow(rowData);
      newRow = sheet.getLastRow();

      if (locked) {
        sheet.autoResizeColumns(1, rowData.length);
        sheet.getRange(newRow, 1, 1, rowData.length).setWrap(true);

        if (newRow % 2 === 0) {
          sheet.getRange(newRow, 1, 1, rowData.length).setBackground('#F8F9FA');
        }
      } else {
        // Data is saved either way; only the cosmetics are skipped.
        Logger.log('Could not acquire lock — row ' + newRow + ' appended unformatted');
      }
    } finally {
      if (locked) lock.releaseLock();
    }

    sendApplicationNotification(data);

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Data saved successfully',
      formType: formType,
      sheetName: SHEET_NAME,
      row: newRow
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log('Error processing CISI form submission: ' + error.toString());

    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Failed to save data: ' + error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ⚠️ This list mirrors the live sheet's row 1. Change it only together with
// prepareApplicationRow() and the sheet itself — see the file header.
function getApplicationHeaders() {
  return [
    'Timestamp',              // A
    'First Name',             // B
    'Last Name',              // C
    'Email',                  // D
    'Phone',                  // E
    'Title',                  // F
    'Company',                // G
    'Years of Experience',    // H
    'LinkedIn Profile',       // I
    'Investment Ready',       // J
    'Future Cohort Month',    // K
    'Pricing Tier',           // L
    'Client ID',              // M
    'Submitted From URL',     // N
    'Application Status',     // O — auto-triage, not Susanne's decision
    'Processing Date'         // P
  ];
  // Q 'Approval'     — Susanne's decision, maintained by hand if you add the
  //                    decision mailer to this project as well
  // R 'Email Status' — written by that mailer. Neither is touched by doPost.
}

// Resolves a column position from the header list, so the reports below never
// depend on a hand-counted index that goes stale when a column is added.
function getApplicationColumnIndex(headerName) {
  const index = getApplicationHeaders().indexOf(headerName);
  if (index === -1) throw new Error('Unknown application column: ' + headerName);
  return index;
}

// Rows from the applications tab, or [] when it is missing or holds only headers.
function getApplicationRows() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  return sheet && sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues()
    : [];
}

// Order must match getApplicationHeaders() exactly.
function prepareApplicationRow(data) {
  return [
    data.timestamp || new Date().toISOString(),
    data.firstName || '',
    data.lastName || '',
    data.email || '',
    data.phone || '',
    data.title || '',
    data.company || '',
    data.experience || '',
    data.linkedin || '',
    data.investment || '',
    data.futureCohortMonth || '',
    data.pricingTier || '',
    data.clientId || 'fintech-circle',
    data.submittedFromUrl || '',
    determineApplicationStatus(data),
    new Date().toLocaleString()
  ];
}

// Auto-triage written at submission time, NOT Susanne's decision.
// Kept identical to the main script so the two streams are judged the same way.
function determineApplicationStatus(data) {
  const experience = parseInt(data.experience) || 0;
  const investment = data.investment || '';

  if (experience >= 15 && investment === 'Yes') {
    return 'Pre-Qualified';
  } else if (experience >= 10) {
    return 'Under Review';
  } else {
    return 'Not Qualified';
  }
}

function sendApplicationNotification(data) {
  try {
    const recipient = APPLICATION_NOTIFICATION_EMAIL;
    const subject = `New CISI Programme Application: ${data.firstName} ${data.lastName}`;

    const body = `
A new programme application has been submitted via CISI:

Programme: ${PROGRAMME_NAME}
Tracked in: ${SHEET_NAME} (CISI spreadsheet)

Name: ${data.firstName} ${data.lastName}
Email: ${data.email}
Phone: ${data.phone}
Title: ${data.title}
Company: ${data.company}
Experience: ${data.experience} years
LinkedIn: ${data.linkedin}
Investment Ready: ${data.investment}
Future Cohort Month: ${data.futureCohortMonth}
Pricing Tier: ${data.pricingTier}
Status: ${determineApplicationStatus(data)}

Submitted: ${data.timestamp}
From: ${data.submittedFromUrl}

Revenue share is owed on this applicant.

Please review the application in the CISI Google Sheet.
    `;

    MailApp.sendEmail(recipient, subject, body);
    Logger.log('CISI application notification sent to: ' + recipient);

  } catch (error) {
    Logger.log('Failed to send CISI application notification: ' + error.toString());
  }
}

// ⚠️ DESTRUCTIVE — wipes the applications tab, including any hand-maintained
// columns such as Approval and Email Status. Only for a brand-new spreadsheet.
// Deliberately NOT on the menu.
function setupCisiSheet() {
  const ui = SpreadsheetApp.getUi();
  const confirmed = ui.alert(
    'Erase all CISI application data?',
    'This clears the ' + SHEET_NAME + ' tab completely, including any Approval ' +
    'column. Only do this on a brand-new spreadsheet.',
    ui.ButtonSet.YES_NO
  );
  if (confirmed !== ui.Button.YES) return 'Cancelled — nothing was changed.';

  setupSheet(SHEET_NAME, getApplicationHeaders(),
    [180, 120, 120, 200, 150, 150, 200, 120, 250, 100, 120, 120, 250, 150, 150, 120]);

  Logger.log('CISI spreadsheet setup complete');
  Logger.log('Notifications will be sent to: ' + APPLICATION_NOTIFICATION_EMAIL);

  return 'Setup complete! Sheet: ' + SHEET_NAME;
}

// Creates the applications tab only if it is missing. Safe on a live sheet,
// unlike setupCisiSheet().
function createCisiSheetIfMissing() {
  const ui = SpreadsheetApp.getUi();

  if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME)) {
    ui.alert(SHEET_NAME + ' already exists — nothing was changed.');
    return;
  }

  setupSheet(SHEET_NAME, getApplicationHeaders(),
    [180, 120, 120, 200, 150, 150, 200, 120, 250, 100, 120, 120, 250, 150, 150, 120]);
  ui.alert(SHEET_NAME + ' created.');
}

function setupSheet(sheetName, headers, columnWidths) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);

  sheet.clear();
  sheet.appendRow(headers);

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold')
    .setBackground('#22C1C9')
    .setFontColor('#FFFFFF')
    .setWrap(true)
    .setFontSize(12);

  for (let i = 0; i < columnWidths.length; i++) {
    sheet.setColumnWidth(i + 1, columnWidths[i]);
  }

  sheet.setFrozenRows(1);

  // Protect the header row. Built from the range object rather than an A1 string —
  // String.fromCharCode(65 + n) produces nonsense past column Z.
  headerRange.protect().setDescription('Header row protection');

  SpreadsheetApp.flush();
}

function createSummaryReport() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const summarySheet = spreadsheet.getSheetByName('Summary') || spreadsheet.insertSheet('Summary');
  summarySheet.clear();

  const rows = getApplicationRows();
  const statusIndex = getApplicationColumnIndex('Application Status');
  const emailIndex = getApplicationColumnIndex('Email');

  const statusCounts = {};
  rows.forEach(row => {
    const status = row[statusIndex];
    if (status === '') return;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  });

  const uniqueEmails = [...new Set(rows.map(row => row[emailIndex]))].length;

  const summaryData = [
    ['CISI x FINTECH Circle Summary Report'],
    [''],
    ['Application Metrics', ''],
    ['Total Applications', rows.length],
    ['Unique Contacts', uniqueEmails],
    [''],
    ['Application Status Breakdown', ''],
    ...Object.entries(statusCounts).map(([status, count]) => [status, count]),
    [''],
    ['Report Generated', new Date().toLocaleString()],
    ['Last Updated', new Date().toISOString()]
  ];

  summarySheet.getRange(1, 1, summaryData.length, 2).setValues(summaryData);

  summarySheet.getRange(1, 1, 1, 2).merge()
    .setFontWeight('bold')
    .setBackground('#22C1C9')
    .setFontColor('#FFFFFF')
    .setFontSize(14);

  // Section headers are found by label rather than by a fixed row number, which
  // would drift as soon as a status value appears or disappears.
  const sectionLabels = ['Application Metrics', 'Application Status Breakdown'];
  summaryData.forEach((row, i) => {
    if (sectionLabels.indexOf(row[0]) !== -1) {
      summarySheet.getRange(i + 1, 1, 1, 2).setFontWeight('bold').setBackground('#F4B942');
    }
  });

  summarySheet.autoResizeColumns(1, 2);

  SpreadsheetApp.getUi().alert('Summary report created!');
}

function exportForMailMerge() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const rows = getApplicationRows();

  if (rows.length === 0) {
    SpreadsheetApp.getUi().alert('No application data found!');
    return;
  }

  const statusIndex = getApplicationColumnIndex('Application Status');
  const qualifiedApps = rows.filter(row => row[statusIndex] === 'Pre-Qualified');

  if (qualifiedApps.length === 0) {
    SpreadsheetApp.getUi().alert('No qualified applications found!');
    return;
  }

  const mergeSheet = spreadsheet.getSheetByName('Mail Merge') || spreadsheet.insertSheet('Mail Merge');
  mergeSheet.clear();

  const mergeHeaders = ['First Name', 'Last Name', 'Email', 'Phone', 'Title', 'Company', 'Experience', 'LinkedIn'];
  mergeSheet.appendRow(mergeHeaders);

  qualifiedApps.forEach(app => {
    mergeSheet.appendRow([
      app[getApplicationColumnIndex('First Name')],
      app[getApplicationColumnIndex('Last Name')],
      app[getApplicationColumnIndex('Email')],
      app[getApplicationColumnIndex('Phone')],
      app[getApplicationColumnIndex('Title')],
      app[getApplicationColumnIndex('Company')],
      app[getApplicationColumnIndex('Years of Experience')],
      app[getApplicationColumnIndex('LinkedIn Profile')]
    ]);
  });

  mergeSheet.getRange(1, 1, 1, mergeHeaders.length).setFontWeight('bold')
    .setBackground('#22C1C9').setFontColor('#FFFFFF');
  mergeSheet.autoResizeColumns(1, mergeHeaders.length);

  SpreadsheetApp.getUi().alert(`Mail merge sheet created with ${qualifiedApps.length} qualified applications!`);
}

// Only ONE onOpen() may exist across an Apps Script project. If you later add the
// decision mailer to this project, add its menu items here rather than in a
// second onOpen().
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CISI Tools')
    .addItem('Create Summary Report', 'createSummaryReport')
    .addItem('Export for Mail Merge', 'exportForMailMerge')
    .addSeparator()
    .addItem('Create Applications Sheet', 'createCisiSheetIfMissing')
    .addItem('View Execution Logs', 'viewLogs')
    .addToUi();
}

function viewLogs() {
  const logs = Logger.getLog();
  if (logs) {
    SpreadsheetApp.getUi().alert('Recent Logs:\n\n' + logs);
  } else {
    SpreadsheetApp.getUi().alert('No recent logs found.');
  }
}
