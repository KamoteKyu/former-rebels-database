const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');

// Remove the native menu bar entirely
Menu.setApplicationMenu(null);

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    frame: false,          // no native title bar / chrome
    titleBarStyle: 'hidden',
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, 'Province_of_Occidental_Mindoro_seal.svg.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading Firebase CDN scripts
      webSecurity: true
    }
  });

  win.loadFile('index.html');

  // Keep menu gone even if something tries to set it
  win.setMenu(null);

  win.on('closed', () => { win = null; });

  // Forward maximize/unmaximize state to renderer so the button can toggle
  win.on('maximize',   () => { if (win) win.webContents.send('window-maximized', true);  });
  win.on('unmaximize', () => { if (win) win.webContents.send('window-maximized', false); });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });

// ── IPC: window controls ──────────────────────────────────────
ipcMain.on('win-minimize',  () => { if (win) win.minimize(); });
ipcMain.on('win-maximize',  () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win-close',     () => { if (win) win.close(); });
ipcMain.handle('win-is-maximized', () => win ? win.isMaximized() : false);
