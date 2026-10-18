@echo off
title WhatsApp Hub (local - for linking a number with FULL history)
cd /d "%~dp0.."
echo.
echo  WhatsApp Hub - local copy on this PC
echo  -------------------------------------
echo  Use this only to link a number with FULL chat history (heavy import).
echo  For everything else use the cloud dashboard: https://zenith-whatsapp-hub.onrender.com
echo.
echo  The dashboard opens at http://localhost:3210 in a few seconds.
echo  When the import is finished, press Ctrl+C here: the number is handed back to the cloud.
echo.
start "" /b cmd /c "timeout /t 8 >nul & start http://localhost:3210/#accounts"
node src\index.js
pause
