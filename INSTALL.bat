@echo off
setlocal enabledelayedexpansion
title FORMER REBELS DATABASE SYSTEM — INSTALLER

echo.
echo  =====================================================
echo   FORMER REBELS DATABASE SYSTEM
echo   INSTALLER v1.0
echo   Provincial Social Welfare and Development Office
echo   Occidental Mindoro
echo  =====================================================
echo.

:: ── TARGET INSTALL DIRECTORY ──────────────────────────────────────────────────
set "INSTALL_DIR=%ProgramFiles%\FRDB"
set "SHORTCUT_DESKTOP=%USERPROFILE%\Desktop\FR DATABASE.lnk"
set "SHORTCUT_START=%APPDATA%\Microsoft\Windows\Start Menu\Programs\FR DATABASE.lnk"

echo  [1/4] Creating installation folder...
if not exist "%INSTALL_DIR%" (
    mkdir "%INSTALL_DIR%"
    if errorlevel 1 (
        echo.
        echo  ERROR: Could not create folder in Program Files.
        echo  Please right-click INSTALL.bat and select "Run as administrator".
        echo.
        pause
        exit /b 1
    )
)

:: ── COPY FILES ────────────────────────────────────────────────────────────────
echo  [2/4] Copying application files...
copy /Y "%~dp0index.html"                                   "%INSTALL_DIR%\index.html"                   >nul
copy /Y "%~dp0app.js"                                       "%INSTALL_DIR%\app.js"                       >nul
copy /Y "%~dp0style.css"                                    "%INSTALL_DIR%\style.css"                    >nul
copy /Y "%~dp0Province_of_Occidental_Mindoro_seal.svg.png"  "%INSTALL_DIR%\Province_of_Occidental_Mindoro_seal.svg.png" >nul
copy /Y "%~dp0LAUNCH.bat"                                   "%INSTALL_DIR%\LAUNCH.bat"                   >nul

echo  [3/4] Creating shortcuts...

:: ── CREATE DESKTOP SHORTCUT VIA POWERSHELL ────────────────────────────────────
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$sc = $ws.CreateShortcut('%SHORTCUT_DESKTOP%');" ^
  "$sc.TargetPath = '%INSTALL_DIR%\LAUNCH.bat';" ^
  "$sc.WorkingDirectory = '%INSTALL_DIR%';" ^
  "$sc.Description = 'Former Rebels Database System';" ^
  "$sc.IconLocation = 'shell32.dll,13';" ^
  "$sc.Save();"

:: ── CREATE START MENU SHORTCUT ────────────────────────────────────────────────
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$sc = $ws.CreateShortcut('%SHORTCUT_START%');" ^
  "$sc.TargetPath = '%INSTALL_DIR%\LAUNCH.bat';" ^
  "$sc.WorkingDirectory = '%INSTALL_DIR%';" ^
  "$sc.Description = 'Former Rebels Database System';" ^
  "$sc.IconLocation = 'shell32.dll,13';" ^
  "$sc.Save();"

echo  [4/4] Installation complete!
echo.
echo  =====================================================
echo   INSTALLATION SUCCESSFUL
echo.
echo   Files installed to:
echo   %INSTALL_DIR%
echo.
echo   Shortcuts created:
echo   - Desktop: FR DATABASE
echo   - Start Menu: FR DATABASE
echo.
echo   IMPORTANT — FIRST TIME SETUP:
echo   The app requires an internet connection to connect
echo   to Firebase. Make sure you are online when launching.
echo.
echo   Default login:
echo   Username : ADMIN
echo   Password : (set in Firebase Authentication)
echo  =====================================================
echo.

set /p LAUNCH="Launch the app now? (Y/N): "
if /i "!LAUNCH!"=="Y" (
    start "" "%INSTALL_DIR%\index.html"
)

echo.
echo  Press any key to exit...
pause >nul
endlocal
