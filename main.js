const { app, BrowserWindow } = require("electron");
const path = require("path");
const { fork } = require("child_process");

// 1. MUST BE FIRST: Handle Squirrel installation events
if (require("electron-squirrel-startup")) {
  app.quit();
  process.exit(0);
}

// 2. Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let serverProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "PayMongo Subscription Viewer",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Automatically retry loading the URL if the server isn't ready
  const loadURL = () => {
    mainWindow.loadURL("http://localhost:3000").catch(() => {
      setTimeout(loadURL, 200);
    });
  };

  loadURL();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Focus the existing window if someone tries to open a second instance
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // 3. Start the server only AFTER the app is ready and we know it's not an install event
  // We set ELECTRON_RUN_AS_NODE to true so the child process acts like Node, not Electron
  serverProcess = fork(path.join(__dirname, "server.js"), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Kill the server process when the app closes
app.on("window-all-closed", () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== "darwin") app.quit();
});
