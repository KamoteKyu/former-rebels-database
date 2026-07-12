@echo off
title FORMER REBELS DATABASE MANAGEMENT SYSTEM
cd /d "%~dp0"

:: Check if node_modules\electron exists
if not exist "%~dp0node_modules\.bin\electron.cmd" (
    echo.
    echo  =====================================================
    echo   ELECTRON NOT INSTALLED — RUNNING INSTALL FIRST...
    echo  =====================================================
    echo.
    call npm install --save-dev electron@31
    if errorlevel 1 (
        echo.
        echo  ERROR: npm install failed. Make sure Node.js is installed.
        echo  Download from: https://nodejs.org
        pause
        exit /b 1
    )
)

echo.
echo  =====================================================
echo   FORMER REBELS DATABASE MANAGEMENT SYSTEM
echo   Starting native app window...
echo  =====================================================
echo.

:: Launch Electron — suppress the console window after startup
start "" /B "%~dp0node_modules\.bin\electron.cmd" "%~dp0"
