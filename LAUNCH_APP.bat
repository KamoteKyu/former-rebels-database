@echo off
title FORMER REBELS DATABASE MANAGEMENT SYSTEM
cd /d "%~dp0"

:: Check if Electron is installed
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

:: Launch Electron using the current directory (already cd'd above)
start "" /B "%~dp0node_modules\.bin\electron.cmd" .
