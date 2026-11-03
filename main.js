const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { Client } = require('minecraft-launcher-core');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let splashWindow;
let tray = null;
const launcher = new Client();

// Mises à jour : téléchargement uniquement après clic sur la flèche
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// --- Chemins ---
const appDataPath = app.getPath('userData');
const minecraftPath = path.join(appDataPath, '.radiant-survie-crack');

// --- Configuration du jeu ---
const MINECRAFT_VERSION = '1.20.1';
const FORGE_VERSION = '47.3.0';
const FORGE_INSTALLER_URL = `https://maven.minecraftforge.net/net/minecraftforge/forge/${MINECRAFT_VERSION}-${FORGE_VERSION}/forge-${MINECRAFT_VERSION}-${FORGE_VERSION}-installer.jar`;
const FORGE_INSTALLER_PATH = path.join(minecraftPath, 'forge', `forge-${MINECRAFT_VERSION}-${FORGE_VERSION}-installer.jar`);

const JAVA_URL = 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse';
const JAVA_DIR = path.join(appDataPath, 'java17');

const SERVER_ADDRESS = 'eu17-free.falixserver.net';
const MODS_API_URL = 'https://api.github.com/repos/AstriazYT/minecraft-rubis-launcher-crack/contents/mods';
const ALLOWED_RAM = ['2G', '4G', '6G', '8G'];

// Session Crack / Offline par défaut
const userAuth = {
    access_token: "null",
    client_token: "null",
    uuid: "12345678-1234-1234-1234-123456789abc",
    name: "Joueur", // Pseudo par défaut
    user_properties: "{}"
};

function send(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

function showMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setSkipTaskbar(false);
        mainWindow.show();
    }
}

// --- Téléchargement avec redirections et progression ---
function download(url, dest, onProgress, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 5) return reject(new Error('Trop de redirections'));

        https.get(url, { headers: { 'User-Agent': 'RadiantLauncher' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                return resolve(download(next, dest, onProgress, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('Téléchargement impossible (HTTP ' + res.statusCode + ')'));
            }

            const total = parseInt(res.headers['content-length'] || '0', 10);
            let done = 0;
            fs.ensureDirSync(path.dirname(dest));
            const file = fs.createWriteStream(dest);

            res.on('data', (chunk) => {
                done += chunk.length;
                if (total && onProgress) onProgress((done / total) * 100);
            });
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        }).on('error', reject);
    });
}

// --- Fenêtres ---
function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 400,
        height: 400,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    splashWindow.loadFile('splash.html');
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 950,
        height: 600,
        frame: false,
        resizable: false,
        show: false,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    mainWindow.loadFile('index.html');

    mainWindow.once('ready-to-show', () => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        mainWindow.show();
        checkServerStatus();
        setInterval(checkServerStatus, 30000);
    });
}

function createTray() {
    if (tray) return;
    tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));

    tray.setToolTip('Radiant Launcher Crack');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Ouvrir Radiant Launcher', click: showMainWindow },
        { label: 'Quitter', click: () => app.quit() }
    ]));
    tray.on('double-click', showMainWindow);
}

// --- Statut du serveur ---
async function checkServerStatus() {
    try {
        const response = await axios.get(`https://api.mcsrvstat.us/2/${SERVER_ADDRESS}`, { timeout: 10000 });
        send('server-status', {
            online: response.data.online,
            players: response.data.players ? response.data.players.online : 0,
            max: response.data.players ? response.data.players.max : 0
        });
    } catch (error) {
        send('server-status', { online: false, players: 0, max: 0 });
    }
}

// --- Java 17 ---
function findJavaw() {
    if (!fs.existsSync(JAVA_DIR)) return null;
    for (const entry of fs.readdirSync(JAVA_DIR)) {
        const exe = path.join(JAVA_DIR, entry, 'bin', 'javaw.exe');
        if (fs.existsSync(exe)) return exe;
    }
    return null;
}

async function ensureJava() {
    const existing = findJavaw();
    if (existing) return existing;

    fs.ensureDirSync(JAVA_DIR);
    const zipPath = path.join(JAVA_DIR, 'java17.zip');
    const label = 'Téléchargement de Java 17 (première fois)...';

    send('status', { text: label, percent: 0 });
    await download(JAVA_URL, zipPath, (percent) => send('status', { text: label, percent }));

    send('status', { text: 'Installation de Java 17...', percent: 100 });
    new AdmZip(zipPath).extractAllTo(JAVA_DIR, true);
    fs.removeSync(zipPath);

    const exe = findJavaw();
    if (!exe) throw new Error('Java 17 introuvable après installation');
    return exe;
}

// --- Forge ---
async function ensureForge() {
    if (fs.existsSync(FORGE_INSTALLER_PATH)) return FORGE_INSTALLER_PATH;

    const label = 'Téléchargement de Forge...';
    send('status', { text: label, percent: 0 });
    await download(FORGE_INSTALLER_URL, FORGE_INSTALLER_PATH, (percent) => {
        send('status', { text: label, percent });
    });
    return FORGE_INSTALLER_PATH;
}

// --- Mods ---
async function syncMods() {
    send('status', 'Vérification des mods...');
    const modsDir = path.join(minecraftPath, 'mods');
    fs.ensureDirSync(modsDir);

    try {
        const res = await axios.get(MODS_API_URL, {
            headers: { 'User-Agent': 'RadiantLauncher' },
            timeout: 15000
        });
        const remote = res.data.filter((f) => f.type === 'file' && f.name.endsWith('.jar'));

        for (let i = 0; i < remote.length; i++) {
            const mod = remote[i];
            const dest = path.join(modsDir, mod.name);

            if (fs.existsSync(dest) && fs.statSync(dest).size === mod.size) continue;

            const label = `Mod ${i + 1}/${remote.length} : ${mod.name}`;
            send('status', { text: label, percent: 0 });
            await download(mod.download_url, dest, (percent) => send('status', { text: label, percent }));
        }
    } catch (e) {
        console.error('Synchro des mods :', e);
        send('status', 'Mods : synchronisation impossible, lancement avec les mods déjà installés.');
    }
}

// --- Écouteurs du launcher ---
launcher.on('debug', (e) => console.log('[MCLC]', e));
launcher.on('data', (e) => console.log('[MC]', e));

launcher.on('progress', (e) => {
    const percent = e.total ? (e.task / e.total) * 100 : 0;
    send('status', { text: `Téléchargement : ${e.type}`, percent });
});

launcher.on('close', () => {
    send('game-closed');
    showMainWindow();
});

// --- Démarrage ---
app.whenReady().then(() => {
    createSplashWindow();
    setTimeout(createMainWindow, 2000);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC : fenêtre ---
ipcMain.on('minimize-window', () => mainWindow?.minimize());
ipcMain.on('close-window', () => mainWindow?.close());

// --- IPC : comptes (Mode Offline / Crack) ---
ipcMain.on('get-accounts', () => {
    // Informe l'interface qu'un compte Crack par défaut est prêt
    send('login-success', { name: userAuth.name, id: "crack-user" });
});

// Possibilité de changer de pseudo depuis l'interface
ipcMain.on('set-offline-username', (event, username) => {
    if (username && username.trim().length > 0) {
        userAuth.name = username.trim();
        send('login-success', { name: userAuth.name, id: "crack-user" });
    }
});

// --- IPC : lancement du jeu ---
ipcMain.on('launch-game', async (event, ramSetting) => {
    try {
        const javaPath = await ensureJava();
        const forgePath = await ensureForge();
        await syncMods();

        const opts = {
            authorization: userAuth,
            root: minecraftPath,
            javaPath,
            forge: forgePath,
            version: { number: MINECRAFT_VERSION, type: 'release' },
            memory: {
                max: ALLOWED_RAM.includes(ramSetting) ? ramSetting : '4G',
                min: '2G'
            },
            quickPlay: { type: 'multiplayer', identifier: SERVER_ADDRESS }
        };

        send('status', 'Lancement de Minecraft...');
        const proc = await launcher.launch(opts);

        if (!proc) {
            send('status', 'Erreur : impossible de lancer le jeu (voir la console).');
            return;
        }

        createTray();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.hide();
            mainWindow.setSkipTaskbar(true);
        }
    } catch (err) {
        console.error(err);
        send('status', 'Erreur : ' + ((err && err.message) || 'lancement impossible.'));
        showMainWindow();
    }
});

// --- IPC : mise à jour du launcher ---
ipcMain.on('check-for-updates', () => {
    send('status', 'Recherche de mise à jour...');
    autoUpdater.checkForUpdates().catch((err) => console.error(err));
});

autoUpdater.on('update-available', (info) => {
    send('status', `Mise à jour ${info.version} trouvée, téléchargement...`);
    autoUpdater.downloadUpdate();
});

autoUpdater.on('update-not-available', () => {
    send('status', 'Votre launcher est à jour !');
});

autoUpdater.on('download-progress', (p) => {
    send('status', { text: 'Téléchargement de la mise à jour...', percent: p.percent });
});

autoUpdater.on('update-downloaded', () => {
    send('status', 'Mise à jour prête ! Redémarrage...');
    setTimeout(() => autoUpdater.quitAndInstall(), 3000);
});

autoUpdater.on('error', (err) => {
    console.error('Erreur de mise à jour :', err);
    send('status', 'Erreur lors de la recherche de mise à jour.');
});
