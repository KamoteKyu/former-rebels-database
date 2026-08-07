const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
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
    center: true,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, 'Province_of_Occidental_Mindoro_seal.svg.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false   // allow file:// page to reach Firebase APIs
    }
  });

  // Allow Firebase auth/firestore/storage network requests
  session.defaultSession.webRequest.onHeadersReceived(function(details, callback) {
    callback({
      responseHeaders: Object.assign({}, details.responseHeaders, {
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: " +
          "https://*.googleapis.com https://*.google.com https://*.firebaseio.com " +
          "https://*.firebaseapp.com https://*.googleapis.com wss://*.firebaseio.com " +
          "https://firebasestorage.googleapis.com https://identitytoolkit.googleapis.com " +
          "https://securetoken.googleapis.com https://www.googleapis.com"
        ]
      })
    });
  });

  win.loadFile('index.html');
  win.setMenu(null);

  win.on('closed', () => { win = null; });

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
