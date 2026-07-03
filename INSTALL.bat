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

:: ── CONFIG ────────────────────────────────────────────────────────────────────
set "APP_URL=https://ocmfrdb.vercel.app"
set "APP_NAME=FR DATABASE"
set "LAUNCHER_DIR=%USERPROFILE%\AppData\Local\FRDB"
set "LAUNCHER=%LAUNCHER_DIR%\launch.bat"
set "SHORTCUT_DESKTOP=%USERPROFILE%\Desktop\%APP_NAME%.lnk"
set "SHORTCUT_START=%APPDATA%\Microsoft\Windows\Start Menu\Programs\%APP_NAME%.lnk"

:: ── LOCATE CHROME ─────────────────────────────────────────────────────────────
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe"       set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"  set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe"        set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

:: ── LOCATE EDGE (fallback only) ───────────────────────────────────────────────
set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"       set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

echo  [1/3] Setting up launcher...
if not exist "%LAUNCHER_DIR%" mkdir "%LAUNCHER_DIR%"

:: Write launch.bat — Chrome preferred, Edge fallback, default browser last resort
> "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo setlocal enabledelayedexpansion

if not "!CHROME!"=="" (
    >> "%LAUNCHER%" echo start "" "!CHROME!" --app="%APP_URL%" --window-size=1280,800 --new-window
    >> "%LAUNCHER%" echo exit /b
) else if not "!EDGE!"=="" (
    >> "%LAUNCHER%" echo start "" "!EDGE!" --app="%APP_URL%" --window-size=1280,800 --new-window
    >> "%LAUNCHER%" echo exit /b
) else (
    >> "%LAUNCHER%" echo start "" "%APP_URL%"
    >> "%LAUNCHER%" echo exit /b
)

echo  [2/3] Creating shortcuts...

:: ── DESKTOP SHORTCUT ──────────────────────────────────────────────────────────
powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut('%SHORTCUT_DESKTOP%'); $sc.TargetPath='%LAUNCHER%'; $sc.WorkingDirectory='%LAUNCHER_DIR%'; $sc.Description='Former Rebels Database System'; $sc.IconLocation='shell32.dll,14'; $sc.Save();"

:: ── START MENU SHORTCUT ───────────────────────────────────────────────────────
powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $sc=$ws.CreateShortcut('%SHORTCUT_START%'); $sc.TargetPath='%LAUNCHER%'; $sc.WorkingDirectory='%LAUNCHER_DIR%'; $sc.Description='Former Rebels Database System'; $sc.IconLocation='shell32.dll,14'; $sc.Save();"

echo  [3/3] Done!
echo.
echo  =====================================================
echo   INSTALLATION SUCCESSFUL
echo.
echo   App URL  : %APP_URL%
echo   Browser  : !CHROME! if not "" echo Chrome (preferred)
if not "!CHROME!"=="" (
    echo   Browser  : Google Chrome
) else if not "!EDGE!"=="" (
    echo   Browser  : Microsoft Edge (Chrome not found)
) else (
    echo   Browser  : Default browser (Chrome/Edge not found)
    echo.
    echo   NOTE: Install Google Chrome for the best experience.
    echo   Download: https://www.google.com/chrome
)
echo.
echo   Shortcuts created:
echo   - Desktop   : %APP_NAME%
echo   - Start Menu: %APP_NAME%
echo.
echo   The app opens as a standalone window with no
echo   address bar — looks and feels like a desktop app.
echo.
echo   DEFAULT LOGIN:
echo   Username : ADMIN
echo   Password : (set in Firebase Authentication)
echo  =====================================================
echo.

set /p "LAUNCH=Launch the app now? (Y/N): "
if /i "!LAUNCH!"=="Y" call "%LAUNCHER%"

echo.
echo  Press any key to exit...
pause >nul
endlocal
