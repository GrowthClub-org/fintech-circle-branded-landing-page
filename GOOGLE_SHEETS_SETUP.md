# Google Sheets Integration Setup Guide

## Overview
This guide shows how to set up Google Sheets integration for the FINTECH Circle landing page to automatically store form submissions in a spreadsheet.

## Step 1: Create Google Sheet

1. Go to [Google Sheets](https://sheets.google.com)
2. Create a new spreadsheet named "FINTECH Circle Registrations"
3. Share the spreadsheet with anyone who needs access to the data

## Step 2: Set Up Google Apps Script

1. In your Google Sheet, go to **Extensions > Apps Script**
2. Delete any default code in the editor
3. Copy the entire contents of `google-sheets-script.js`
4. Paste it into the Apps Script editor
5. Click **Save project** (💾 icon)

## Step 3: Deploy as Web App

1. In the Apps Script editor, click **Deploy > New deployment**
2. Choose **Web app** as the deployment type
3. Configure the deployment:
   - **Description**: FINTECH Circle Form Handler
   - **Execute as**: Me (your Google account)
   - **Who has access**: Anyone (required for form submissions)
4. Click **Deploy**
5. **Authorize** the script when prompted (you may need to review permissions)
6. Copy the **Web app URL** - this is your script ID

## Step 4: Update Landing Page

1. Open the `index.html` file
2. Find this line (around line 1733):
   ```javascript
   const GOOGLE_SHEETS_URL = 'https://script.google.com/macros/s/YOUR_GOOGLE_SHEETS_SCRIPT_ID/exec';
   ```
3. Replace `YOUR_GOOGLE_SHEETS_SCRIPT_ID` with your actual script ID from step 3

## Step 5: Test the Integration

1. Open the landing page in your browser
2. Fill out and submit the registration form
3. Check your Google Sheet - you should see a new row with the submission data

## Data Structure

The Google Sheet will capture the following fields:

| Column | Description |
|--------|-------------|
| Timestamp | When the form was submitted |
| Name | Registrant's full name |
| Email | Registrant's email address |
| Client ID | Always "fintech-circle" |
| Submitted From URL | Page where form was submitted |
| Broadcast ID | Webinar broadcast ID |
| Webinar Title | Webinar title |
| Webinar Date | Webinar date |
| Source | "Landing Page Registration" |
| Processing Date | When Google Sheets processed the data |

## Advanced Features

### Custom Menu Functions
After setting up the script, you'll see a "FINTECH Circle Tools" menu in your Google Sheet with:

- **Setup Spreadsheet**: Formats the sheet with proper headers and styling
- **Create Summary Report**: Generates a summary of registration statistics

### Automatic Formatting
The script automatically:
- Adds headers with FINTECH Circle branding colors
- Alternates row colors for readability
- Auto-resizes columns
- Freezes the header row
- Protects the header from accidental edits

## Troubleshooting

### Common Issues

1. **"Script not found" error**
   - Make sure you've deployed the script as a Web App
   - Check that the URL in your HTML matches the deployed URL exactly

2. **"Permission denied" error**
   - Ensure the Web App is set to "Anyone" can access
   - Re-deploy the script if you changed permissions

3. **No data appearing in sheet**
   - Check browser console for JavaScript errors
   - Verify the form submission is successful
   - Check Google Apps Script execution logs

### Debugging

1. Open Apps Script editor
2. Go to **Executions** (left menu)
3. Check for any error messages
4. Use **Logger.log()** in the script for debugging

## Security Notes

- The script processes data but doesn't store sensitive information
- Anyone with the Web App URL can submit data
- Consider adding additional validation if needed
- Regularly review who has access to your Google Sheet

## Maintenance

- Monthly: Review the data and create summary reports
- Quarterly: Check script execution logs for errors
- Annually: Review permissions and access controls

## Support

If you encounter issues:
1. Check the Apps Script execution logs
2. Verify the Web App deployment settings
3. Ensure the HTML form is properly configured
4. Test with different browsers if needed
