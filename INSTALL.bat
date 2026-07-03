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

:: ── APP URL ───────────────────────────────────────────────────────────────────
set "APP_URL=https://ocmfrdb.vercel.app"
set "APP_NAME=FR DATABASE"
set "SHORTCUT_DESKTOP=%USERPROFILE%\Desktop\%APP_NAME%.lnk"
set "SHORTCUT_START=%APPDATA%\Microsoft\Windows\Start Menu\Programs\%APP_NAME%.lnk"
set "LAUNCHER=%USERPROFILE%\AppData\Local\FRDB\launch.bat"
set "LAUNCHER_DIR=%USERPROFILE%\AppData\Local\FRDB"

echo  [1/3] Setting up launcher...
if not exist "%LAUNCHER_DIR%" mkdir "%LAUNCHER_DIR%"

:: Write a small launcher that opens the app in Chrome/Edge
(
echo @echo off
echo set "URL=%APP_URL%"
echo.
echo :: Try Google Chrome first
echo set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
echo set "CHROME86=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
echo set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
echo set "EDGE2=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
echo.
echo if exist "!CHROME!" (
echo     start "" "!CHROME!" --app="%APP_URL%" --window-size=1280,800
echo     exit /b
echo ^)
echo if exist "!CHROME86!" (
echo     start "" "!CHROME86!" --app="%APP_URL%" --window-size=1280,800
echo     exit /b
echo ^)
echo if exist "!EDGE2!" (
echo     start "" "!EDGE2!" --app="%APP_URL%" --window-size=1280,800
echo     exit /b
echo ^)
echo if exist "!EDGE!" (
echo     start "" "!EDGE!" --app="%APP_URL%" --window-size=1280,800
echo     exit /b
echo ^)
echo :: Fallback: open in default browser
echo start "" "%APP_URL%"
) > "%LAUNCHER%"

echo  [2/3] Creating shortcuts...

:: ── DESKTOP SHORTCUT ─────────────────────────────────────────────────────────
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%SHORTCUT_DESKTOP%'); $sc.TargetPath = '%LAUNCHER%'; $sc.WorkingDirectory = '%LAUNCHER_DIR%'; $sc.Description = 'Former Rebels Database System'; $sc.IconLocation = 'shell32.dll,14'; $sc.Save();"

:: ── START MENU SHORTCUT ───────────────────────────────────────────────────────
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%SHORTCUT_START%'); $sc.TargetPath = '%LAUNCHER%'; $sc.WorkingDirectory = '%LAUNCHER_DIR%'; $sc.Description = 'Former Rebels Database System'; $sc.IconLocation = 'shell32.dll,14'; $sc.Save();"

echo  [3/3] Done!
echo.
echo  =====================================================
echo   INSTALLATION SUCCESSFUL
echo.
echo   App URL  : %APP_URL%
echo   Shortcut : Desktop ^> %APP_NAME%
echo   Shortcut : Start Menu ^> %APP_NAME%
echo.
echo   The app opens in Chrome/Edge as a standalone window
echo   (no address bar) — looks and feels like a desktop app.
echo.
echo   REQUIREMENTS:
echo   - Internet connection (app runs on Vercel + Firebase)
echo   - Google Chrome or Microsoft Edge
echo.
echo   DEFAULT LOGIN:
echo   Username : ADMIN
echo   Password : (set in Firebase Authentication)
echo  =====================================================
echo.

set /p LAUNCH="Launch the app now? (Y/N): "
if /i "!LAUNCH!"=="Y" (
    call "%LAUNCHER%"
)

echo.
echo  Press any key to exit...
pause >nul
endlocal
