// Enhanced Google Apps Script for FINTECH Circle Form Submissions
// Handles registration, programme application, and webinar replay forms
// Deploy this script as a Web App to get your script URL
//
// ⚠️ getApplicationHeaders() must match the LIVE sheet's row 1, column for column.
// doPost only writes a header row when the tab is empty, so on a sheet that already
// holds data the header row is never corrected — the code silently starts writing
// rows one column out of step with the headers and with every historical row.
//
// Pricing Tier sits at L because that is where it is in the live sheet. To add a
// field later: insert the column in the sheet FIRST (which shifts existing data
// across with it), then add it at the matching position here. Appending at the end
// is only safe while nothing is kept in the columns to the right — here, Q and R.
//
// CISI applications are NOT handled here. They post to their own Web App, bound to
// the CISI spreadsheet — see google-sheets-script-cisi.js. Keep the application
// columns and determineApplicationStatus() identical between the two files.

function doPost(e) {
  try {
    // Parse the incoming JSON data
    const data = JSON.parse(e.postData.contents);

    // Determine the form type and sheet name
    const formType = data.formType || 'registration';
    let sheetName;
    if (formType === 'application') {
      sheetName = 'Programme Applicants';
    } else if (formType === 'replay') {
      sheetName = 'Replays';
    } else {
      sheetName = 'Registrants';
    }

    // Get the active spreadsheet and sheet
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);

    // Set up headers if sheet is new
    if (sheet.getLastRow() === 0) {
      let headers;
      if (formType === 'application') {
        headers = getApplicationHeaders();
      } else if (formType === 'replay') {
        headers = getReplayHeaders();
      } else {
        headers = getRegistrationHeaders();
      }
      sheet.appendRow(headers);

      // Format headers
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold')
        .setBackground('#22C1C9')
        .setFontColor('#FFFFFF')
        .setWrap(true);
    }

    // Prepare the row data based on form type
    let rowData;
    if (formType === 'application') {
      rowData = prepareApplicationRow(data);
    } else if (formType === 'replay') {
      rowData = prepareReplayRow(data);
    } else {
      rowData = prepareRegistrationRow(data);
    }

    // Append and format under a lock. Two submissions landing in the same second
    // would otherwise both read the same getLastRow() and format each other's row.
    const lock = LockService.getScriptLock();
    const locked = lock.tryLock(30000);
    let newRow;

    try {
      sheet.appendRow(rowData);
      newRow = sheet.getLastRow();

      if (locked) {
        // Auto-resize columns
        sheet.autoResizeColumns(1, rowData.length);

        // Format the new row
        sheet.getRange(newRow, 1, 1, rowData.length).setWrap(true);

        // Apply alternating row colors
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

    // Send notification email for programme applications
    if (formType === 'application') {
      sendApplicationNotification(data);
    }

    // Send notification for webinar replay requests
    if (formType === 'replay') {
      sendReplayNotification(data);
    }

    // Return success response
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Data saved successfully',
      formType: formType,
      sheetName: sheetName,
      row: newRow
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    // Log the error for debugging
    Logger.log('Error processing form submission: ' + error.toString());

    // Return error response
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'Failed to save data: ' + error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// Where the team is notified. One constant, so the address cannot drift between
// the notification function and the setup log.
const APPLICATION_NOTIFICATION_EMAIL = 'applications@fintechcircle.com';
const REPLAY_NOTIFICATION_EMAIL = 'replay@fintechcircle.com';

// Headers for registration form
function getRegistrationHeaders() {
  return [
    'Timestamp',
    'Name',
    'Email',
    'Phone',
    'Company',
    'Client ID',
    'Submitted From URL',
    'Broadcast ID',
    'Webinar Title',
    'Webinar Date',
    'Source',
    'Processing Date'
  ];
}

// Headers for programme application form
//
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
  // Q 'Approval'     — Susanne's decision, maintained by hand, read by DecisionEmails
  // R 'Email Status' — written by DecisionEmails. Neither is touched by doPost.
}

// Headers for webinar replay form
function getReplayHeaders() {
  return [
    'Timestamp',
    'Name',
    'Email',
    'Client ID',
    'Submitted From URL',
    'Broadcast ID',
    'Webinar Title',
    'Webinar Date',
    'Source',
    'Processing Date'
  ];
}

// Resolves a column position from the header list, so the reports below never
// depend on a hand-counted index that goes stale when a column is added.
function getApplicationColumnIndex(headerName) {
  const index = getApplicationHeaders().indexOf(headerName);
  if (index === -1) throw new Error('Unknown application column: ' + headerName);
  return index;
}

// Prepare data row for registration form
function prepareRegistrationRow(data) {
  return [
    data.timestamp || new Date().toISOString(),
    data.name || '',
    data.email || '',
    data.phone || '',
    data.company || '',
    data.clientId || '',
    data.submittedFromUrl || '',
    data.broadcastId || '',
    data.webinarTitle || '',
    data.webinarDate || '',
    data.source || '',
    new Date().toLocaleString()
  ];
}

// Prepare data row for programme application form
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

// Prepare data row for webinar replay form
function prepareReplayRow(data) {
  return [
    data.timestamp || new Date().toISOString(),
    data.name || '',
    data.email || '',
    data.clientId || 'fintech-circle',
    data.submittedFromUrl || '',
    data.broadcastId || '',
    data.webinarTitle || '',
    data.webinarDate || '',
    data.source || 'webinar-replay',
    new Date().toLocaleString()
  ];
}

// Determine application status based on criteria.
// This is an auto-triage written at submission time, NOT Susanne's decision —
// that lives in the Decision column and is read by DecisionEmails.gs.
//
// ⚠️ google-sheets-script-cisi.js carries an identical copy. Change both together,
// or the two streams stop being judged the same way.
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

// Send email notification for programme applications
function sendApplicationNotification(data) {
  try {
    const recipient = APPLICATION_NOTIFICATION_EMAIL;
    const subject = `New Programme Application: ${data.firstName} ${data.lastName}`;

    const body = `
A new programme application has been submitted:

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

Please review the application in the Google Sheet.
    `;

    MailApp.sendEmail(recipient, subject, body);
    Logger.log('Application notification sent to: ' + recipient);

  } catch (error) {
    Logger.log('Failed to send application notification: ' + error.toString());
  }
}

// Send email notification for webinar replay requests
function sendReplayNotification(data) {
  try {
    const recipient = REPLAY_NOTIFICATION_EMAIL;
    const subject = `New Webinar Replay Request: ${data.name}`;

    const body = `
A new webinar replay request has been submitted:

Name: ${data.name}
Email: ${data.email}
Webinar Title: ${data.webinarTitle}
Webinar Date: ${data.webinarDate}

Submitted: ${data.timestamp}
From: ${data.submittedFromUrl}

Please send the replay link to the requester.
    `;

    MailApp.sendEmail(recipient, subject, body);
    Logger.log('Replay notification sent to: ' + recipient);

  } catch (error) {
    Logger.log('Failed to send replay notification: ' + error.toString());
  }
}

// ⚠️ DESTRUCTIVE — initialises an EMPTY spreadsheet for a new client.
// setupSheet() calls sheet.clear(), which wipes every row, plus any hand-added
// columns it does not know about (Approval, Email Status).
// Deliberately NOT on the menu. Never run this against a live sheet.
function setupSpreadsheet() {
  const ui = SpreadsheetApp.getUi();
  const confirmed = ui.alert(
    'Erase all data?',
    'This clears Registrants, Programme Applicants and Replays completely, ' +
    'including the Decision column. Only do this on a brand-new spreadsheet.',
    ui.ButtonSet.YES_NO
  );
  if (confirmed !== ui.Button.YES) return 'Cancelled — nothing was changed.';

  // Setup Registrants sheet
  setupSheet('Registrants', getRegistrationHeaders(), [180, 150, 200, 140, 180, 100, 250, 120, 200, 150, 150, 150]);

  // Setup Programme Applicants sheet
  setupSheet('Programme Applicants', getApplicationHeaders(), [180, 120, 120, 200, 150, 150, 200, 120, 250, 100, 120, 120, 250, 150, 150, 120]);

  // Setup Replays sheet
  setupSheet('Replays', getReplayHeaders(), [180, 150, 200, 100, 250, 120, 200, 150, 120, 150]);

  // Log setup completion
  Logger.log('FINTECH Circle spreadsheet setup completed successfully');
  Logger.log('Email notifications will be sent to:');
  Logger.log('- Applications: ' + APPLICATION_NOTIFICATION_EMAIL);
  Logger.log('- Replay Requests: ' + REPLAY_NOTIFICATION_EMAIL);
  Logger.log('Sheets configured: Registrants, Programme Applicants, Replays');

  return 'Spreadsheet setup complete! Sheets: Registrants, Programme Applicants, Replays';
}

// Function to set up individual sheet
function setupSheet(sheetName, headers, columnWidths) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);

  // Clear the sheet
  sheet.clear();

  // Set up headers
  sheet.appendRow(headers);

  // Format headers
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold')
    .setBackground('#22C1C9')
    .setFontColor('#FFFFFF')
    .setWrap(true)
    .setFontSize(12);

  // Set column widths
  for (let i = 0; i < columnWidths.length; i++) {
    sheet.setColumnWidth(i + 1, columnWidths[i]);
  }

  // Freeze the header row
  sheet.setFrozenRows(1);

  // Protect the header row. Built from the range object rather than an A1 string —
  // String.fromCharCode(65 + n) produces nonsense past column Z.
  headerRange.protect().setDescription('Header row protection');

  SpreadsheetApp.flush();
}

// Function to create a summary report
function createSummaryReport() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  // Create summary sheet
  const summarySheet = spreadsheet.getSheetByName('Summary') || spreadsheet.insertSheet('Summary');
  summarySheet.clear();

  // Get registration data
  const regSheet = spreadsheet.getSheetByName('Registrants');
  const regData = regSheet && regSheet.getLastRow() > 1 ?
    regSheet.getRange(2, 1, regSheet.getLastRow() - 1, regSheet.getLastColumn()).getValues() : [];

  // Get application data
  const appSheet = spreadsheet.getSheetByName('Programme Applicants');
  const appData = appSheet && appSheet.getLastRow() > 1 ?
    appSheet.getRange(2, 1, appSheet.getLastRow() - 1, appSheet.getLastColumn()).getValues() : [];

  // Get replay data
  const replaySheet = spreadsheet.getSheetByName('Replays');
  const replayData = replaySheet && replaySheet.getLastRow() > 1 ?
    replaySheet.getRange(2, 1, replaySheet.getLastRow() - 1, replaySheet.getLastColumn()).getValues() : [];

  // Calculate statistics
  const totalRegistrations = regData.length;
  const totalApplications = appData.length;
  const totalReplayRequests = replayData.length;
  const uniqueEmails = [...new Set([...regData.map(row => row[2]), ...appData.map(row => row[3]), ...replayData.map(row => row[2])])].length;

  // Application status breakdown
  const statusIndex = getApplicationColumnIndex('Application Status');
  const statusCounts = {};
  appData.forEach(row => {
    const status = row[statusIndex];
    if (status === '') return;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  });

  // Create summary data
  const summaryData = [
    ['FINTECH Circle Summary Report'],
    [''],
    ['Registration Metrics', ''],
    ['Total Registrations', totalRegistrations],
    ['Total Applications', totalApplications],
    ['Total Replay Requests', totalReplayRequests],
    ['Unique Contacts', uniqueEmails],
    [''],
    ['Application Status Breakdown', ''],
    ...Object.entries(statusCounts).map(([status, count]) => [status, count]),
    [''],
    ['Report Generated', new Date().toLocaleString()],
    ['Last Updated', new Date().toISOString()]
  ];

  summarySheet.getRange(1, 1, summaryData.length, 2).setValues(summaryData);

  // Format summary
  summarySheet.getRange(1, 1, 1, 2).merge()
    .setFontWeight('bold')
    .setBackground('#22C1C9')
    .setFontColor('#FFFFFF')
    .setFontSize(14);

  summarySheet.getRange(3, 1, 1, 2).setFontWeight('bold').setBackground('#F4B942');
  summarySheet.getRange(9, 1, 1, 2).setFontWeight('bold').setBackground('#F4B942');

  summarySheet.autoResizeColumns(1, 2);

  SpreadsheetApp.getUi().alert('Summary report created!');
}

// Function to export data for mail merge
function exportForMailMerge() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName('Programme Applicants');

  if (!sheet || sheet.getLastRow() <= 1) {
    SpreadsheetApp.getUi().alert('No application data found!');
    return;
  }

  // Get qualified applications
  const statusIndex = getApplicationColumnIndex('Application Status');
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const qualifiedApps = data.filter(row => row[statusIndex] === 'Pre-Qualified');

  if (qualifiedApps.length === 0) {
    SpreadsheetApp.getUi().alert('No qualified applications found!');
    return;
  }

  // Create mail merge sheet
  const mergeSheet = spreadsheet.getSheetByName('Mail Merge') || spreadsheet.insertSheet('Mail Merge');
  mergeSheet.clear();

  // Set up mail merge headers
  const mergeHeaders = ['First Name', 'Last Name', 'Email', 'Phone', 'Title', 'Company', 'Experience', 'LinkedIn'];
  mergeSheet.appendRow(mergeHeaders);

  // Add qualified applications
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

  // Format mail merge sheet
  mergeSheet.getRange(1, 1, 1, mergeHeaders.length).setFontWeight('bold')
    .setBackground('#22C1C9').setFontColor('#FFFFFF');
  mergeSheet.autoResizeColumns(1, mergeHeaders.length);

  SpreadsheetApp.getUi().alert(`Mail merge sheet created with ${qualifiedApps.length} qualified applications!`);
}

// Add custom menu for easy access.
// Only ONE onOpen() may exist across the whole Apps Script project — the decision
// mailer's menu items are added here rather than in a second onOpen().
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('FINTECH Circle Tools')
    .addItem('Create Summary Report', 'createSummaryReport')
    .addItem('Export for Mail Merge', 'exportForMailMerge')
    .addSeparator()
    .addItem('Preview Decision Emails', 'previewDecisionEmails')
    .addItem('Resend Decision for Selected Row', 'resendDecisionForSelectedRow')
    .addItem('Install Decision Dropdown', 'installDecisionDropdown')
    .addSeparator()
    .addItem('View Execution Logs', 'viewLogs')
    .addToUi();
}

// Function to view execution logs
function viewLogs() {
  const logs = Logger.getLog();
  if (logs) {
    SpreadsheetApp.getUi().alert('Recent Logs:\n\n' + logs);
  } else {
    SpreadsheetApp.getUi().alert('No recent logs found.');
  }
}
