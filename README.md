# Cyclic OS - Google Calendar Sync Setup

## Overview
Cyclic OS now includes Google Calendar synchronization functionality. This allows you to sync your Google Calendar events with your cyclic calendar notes.

## Prerequisites
To use the Google Calendar sync feature, you need to obtain API credentials from Google Cloud Console:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google Calendar API for your project
4. Create credentials (OAuth 2.0 Client ID) for a web application
5. Add authorized JavaScript origins: `http://localhost:5173` (for development) and your production URL
6. Download the credentials file

## Environment Variables
Create a `.env` file in the root of your project with the following variables:

```env
VITE_SUPABASE_URL=your_supabase_url_here
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key_here
VITE_GOOGLE_API_KEY=your_google_api_key_here
VITE_GOOGLE_CLIENT_ID=your_google_client_id_here
```

## How to Use
1. Click the "Sync with Google" button in the sidebar
2. Sign in to your Google account when prompted
3. Grant the necessary permissions to access your Google Calendar
4. Your calendar events will be fetched and displayed on the corresponding dates in your cyclic calendar

## Features
- Syncs Google Calendar events to the corresponding dates in your cyclic calendar
- Displays calendar events as red dots on the calendar days
- Preserves existing notes while adding calendar events
- Updates both ways (notes stored in Supabase)

## Troubleshooting
- Make sure your Google API credentials are properly configured
- Ensure the Google Calendar API is enabled in your Google Cloud Console
- Check browser console for any error messages during sync

## Security Note
Never commit your `.env` file to version control. It's already included in `.gitignore`.