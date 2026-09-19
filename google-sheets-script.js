// Google Apps Script for FINTECH Circle Form Submissions
// Deploy this script as a Web App to get your script URL

function doPost(e) {
  try {
    // Parse the incoming JSON data
    const data = JSON.parse(e.postData.contents);
    
    // Get the active spreadsheet and sheet
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName('Registrations') || spreadsheet.insertSheet('Registrations');
    
    // Set up headers if sheet is new
    if (sheet.getLastRow() === 0) {
      const headers = [
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
      sheet.appendRow(headers);
      
      // Format headers
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold')
        .setBackground('#22C1C9')
        .setFontColor('#FFFFFF')
        .setWrap(true);
    }
    
    // Prepare the row data
    const rowData = [
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
    
    // Return success response
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Data saved successfully',
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

// Function to set up the spreadsheet with proper formatting
function setupSpreadsheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName('Registrations') || spreadsheet.insertSheet('Registrations');
  
  // Clear the sheet
  sheet.clear();
  
  // Set up headers
  const headers = [
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
  
  sheet.appendRow(headers);
  
  // Format headers
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold')
    .setBackground('#22C1C9')
    .setFontColor('#FFFFFF')
    .setWrap(true)
    .setFontSize(12);
  
  // Set column widths
  const columnWidths = [180, 150, 200, 100, 250, 120, 200, 150, 150, 150];
  for (let i = 0; i < columnWidths.length; i++) {
    sheet.setColumnWidth(i + 1, columnWidths[i]);
  }
  
  // Freeze the header row
  sheet.setFrozenRows(1);
  
  // Add protection to the header row
  const range = sheet.getRange('A1:J1');
  range.protect().setDescription('Header row protection');
  
  SpreadsheetApp.flush();
  
  return 'Spreadsheet setup complete!';
}

// Function to create a summary report
function createSummaryReport() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName('Registrations');
  
  if (!sheet || sheet.getLastRow() <= 1) {
    SpreadsheetApp.getUi().alert('No registration data found!');
    return;
  }
  
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  
  // Calculate statistics
  const totalRegistrations = data.length;
  const uniqueEmails = [...new Set(data.map(row => row[1]))].length;
  const clientIds = [...new Set(data.map(row => row[3]))];
  
  // Create summary sheet
  const summarySheet = spreadsheet.getSheetByName('Summary') || spreadsheet.insertSheet('Summary');
  summarySheet.clear();
  
  // Add summary data
  const summaryData = [
    ['Metric', 'Value'],
    ['Total Registrations', totalRegistrations],
    ['Unique Emails', uniqueEmails],
    ['Client IDs', clientIds.join(', ')],
    ['Report Generated', new Date().toLocaleString()]
  ];
  
  summarySheet.getRange(1, 1, summaryData.length, 2).setValues(summaryData);
  summarySheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#22C1C9').setFontColor('#FFFFFF');
  summarySheet.autoResizeColumns(1, 2);
  
  SpreadsheetApp.getUi().alert('Summary report created!');
}

// Add custom menu for easy access
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('FINTECH Circle Tools')
    .addItem('Setup Spreadsheet', 'setupSpreadsheet')
    .addItem('Create Summary Report', 'createSummaryReport')
    .addToUi();
}
