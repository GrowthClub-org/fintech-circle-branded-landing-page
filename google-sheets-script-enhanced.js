// Enhanced Google Apps Script for FINTECH Circle Form Submissions
// Handles both simple registration and detailed programme application forms
// Deploy this script as a Web App to get your script URL

function doPost(e) {
  try {
    // Parse the incoming JSON data
    const data = JSON.parse(e.postData.contents);
    
    // Determine the form type and sheet name
    const formType = data.formType || 'registration';
    let sheetName = 'Registrants';
    if (formType === 'application') sheetName = 'Programme Applicants';
    if (formType === 'replay') sheetName = 'Replays';
    
    // Get the active spreadsheet and sheet
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
    
    // Set up headers if sheet is new
    if (sheet.getLastRow() === 0) {
      const headers = formType === 'application' ? getApplicationHeaders() : getRegistrationHeaders();
      sheet.appendRow(headers);
      
      // Format headers
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold')
        .setBackground('#22C1C9')
        .setFontColor('#FFFFFF')
        .setWrap(true);
    }
    
    // Prepare the row data based on form type
    const rowData = formType === 'application' ? prepareApplicationRow(data) : prepareRegistrationRow(data);
    
    // Append the new row
    sheet.appendRow(rowData);
    
    // Auto-resize columns
    sheet.autoResizeColumns(1, rowData.length);
    
    // Format the new row
    const newRow = sheet.getLastRow();
    sheet.getRange(newRow, 1, 1, rowData.length).setWrap(true);
    
    // Apply alternating row colors
    if (newRow % 2 === 0) {
      sheet.getRange(newRow, 1, 1, rowData.length).setBackground('#F8F9FA');
    }
    
    // Send notification email for programme applications
    if (formType === 'application') {
      sendApplicationNotification(data);
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

// Headers for registration form
function getRegistrationHeaders() {
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

// Headers for programme application form
function getApplicationHeaders() {
  return [
    'Timestamp',
    'First Name',
    'Last Name',
    'Email',
    'Phone',
    'Title',
    'Company',
    'Years of Experience',
    'LinkedIn Profile',
    'Investment Ready',
    'Client ID',
    'Submitted From URL',
    'Application Status',
    'Processing Date'
  ];
}

// Prepare data row for registration form
function prepareRegistrationRow(data) {
  return [
    data.timestamp || new Date().toISOString(),
    data.name || '',
    data.email || '',
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
    data.clientId || 'fintech-circle',
    data.submittedFromUrl || '',
    determineApplicationStatus(data),
    new Date().toLocaleString()
  ];
}

// Determine application status based on criteria
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
    const recipient = 'applications@fintechcircle.com'; // Change to actual recipient
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

// Update the email recipient in setup function
function setupSpreadsheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  
  // Setup Registrants sheet
  setupSheet('Registrants', getRegistrationHeaders(), [180, 150, 200, 100, 250, 120, 200, 150, 150, 150]);
  
  // Setup Programme Applicants sheet
  setupSheet('Programme Applicants', getApplicationHeaders(), [180, 120, 120, 200, 150, 150, 200, 120, 250, 100, 120, 120, 250, 150]);
  
  // Log setup completion
  Logger.log('FINTECH Circle spreadsheet setup completed successfully');
  Logger.log('Email notifications will be sent to: applications@fintechcircle.com');
  Logger.log('Sheets configured: Registrants, Programme Applicants');
  
  return 'Spreadsheet setup complete! Sheets: Registrants, Programme Applicants';
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
  
  // Add protection to the header row
  const range = sheet.getRange('A1:' + String.fromCharCode(65 + headers.length - 1) + '1');
  range.protect().setDescription('Header row protection');
  
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
  
  // Calculate statistics
  const totalRegistrations = regData.length;
  const totalApplications = appData.length;
  const uniqueEmails = [...new Set([...regData.map(row => row[2]), ...appData.map(row => row[3])])].length;
  
  // Application status breakdown
  const statusCounts = {};
  appData.forEach(row => {
    const status = row[12]; // Application status column
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  });
  
  // Create summary data
  const summaryData = [
    ['FINTECH Circle Summary Report'],
    [''],
    ['Registration Metrics', ''],
    ['Total Registrations', totalRegistrations],
    ['Total Applications', totalApplications],
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
  summarySheet.getRange(8, 1, 1, 2).setFontWeight('bold').setBackground('#F4B942');
  
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
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const qualifiedApps = data.filter(row => row[12] === 'Pre-Qualified');
  
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
      app[1], // First Name
      app[2], // Last Name
      app[3], // Email
      app[4], // Phone
      app[5], // Title
      app[6], // Company
      app[7], // Experience
      app[8]  // LinkedIn
    ]);
  });
  
  // Format mail merge sheet
  mergeSheet.getRange(1, 1, 1, mergeHeaders.length).setFontWeight('bold')
    .setBackground('#22C1C9').setFontColor('#FFFFFF');
  mergeSheet.autoResizeColumns(1, mergeHeaders.length);
  
  SpreadsheetApp.getUi().alert(`Mail merge sheet created with ${qualifiedApps.length} qualified applications!`);
}

// Add custom menu for easy access
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('FINTECH Circle Tools')
    .addItem('Setup Spreadsheet', 'setupSpreadsheet')
    .addItem('Create Summary Report', 'createSummaryReport')
    .addItem('Export for Mail Merge', 'exportForMailMerge')
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
