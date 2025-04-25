const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// Additional status tracking
let batteryStatus = {
    level: 100,  // Default to 100%
    isLow: false
};
let pendingCommands = [];
let errorState = null;

// Configuration (move these to a config file later)
const CONFIG = {
    comPort: 'COM3',
    baudRate: 9600,
    logFile: path.join(__dirname, 'detection_log.txt'),
    scriptPath: path.join(__dirname, 'changeTabs.ahk'),
    webPort: 8080,
    systemActive: true
};

// Initialize express app for dashboard
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, 'dashboard')));
app.use(express.json());

// API routes
app.get('/api/status', (req, res) => {
    res.json({
        systemActive: CONFIG.systemActive,
        lastDetection: lastDetectionTime ? new Date(lastDetectionTime).toLocaleString() : 'None',
        transmitterConnected: transmitterConnected,
        sensitivity: currentSettings.sensitivity,
        safeScreen: currentSettings.safeScreen,
        cooldown: currentSettings.cooldown,
        battery: batteryStatus,
        pendingCommands: pendingCommands.length,
        errorState: errorState
    });
});

app.get('/api/logs', (req, res) => {
    res.json(detectionLogs.slice(-100)); // Return last 100 logs
});

app.post('/api/settings', (req, res) => {
    const { sensitivity, safeScreen, cooldown } = req.body;

    if (sensitivity !== undefined) {
        currentSettings.sensitivity = sensitivity;
        // Send to Arduino if connected
        if (port && port.isOpen) {
            port.write(`SET_DISTANCE:${sensitivity}\n`);
        }
    }

    if (safeScreen !== undefined) {
        currentSettings.safeScreen = safeScreen;
        // Update config.ini for AutoHotkey
        updateAutoHotkeyConfig(safeScreen);
    }

    if (cooldown !== undefined) {
        currentSettings.cooldown = cooldown;
        // Send to Arduino if connected
        if (port && port.isOpen) {
            port.write(`SET_COOLDOWN:${cooldown}\n`);
        }
    }

    // Save settings to file
    saveSettings();

    res.json({ success: true, settings: currentSettings });
});

app.post('/api/system', (req, res) => {
    const { active } = req.body;

    if (active !== undefined) {
        CONFIG.systemActive = active;
    }

    res.json({ success: true, systemActive: CONFIG.systemActive });
});

app.post('/api/test', (req, res) => {
    // Trigger a test detection
    handleDetection('Test detection');
    res.json({ success: true });
});

// WebSocket for real-time updates
wss.on('connection', (ws) => {
    // Send initial status
    ws.send(JSON.stringify({
        type: 'status',
        data: {
            systemActive: CONFIG.systemActive,
            lastDetection: lastDetectionTime ? new Date(lastDetectionTime).toLocaleString() : 'None',
            transmitterConnected: transmitterConnected
        }
    }));

    // Send logs
    ws.send(JSON.stringify({
        type: 'logs',
        data: detectionLogs.slice(-20) // Send last 20 logs
    }));

    // Handle messages from client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'toggleSystem') {
                CONFIG.systemActive = data.active;
                broadcastStatus();
            }
            else if (data.type === 'testDetection') {
                handleDetection('Test detection');
            }
            else if (data.type === 'updateSettings') {
                if (data.settings.sensitivity !== undefined) {
                    currentSettings.sensitivity = data.settings.sensitivity;
                    if (port && port.isOpen) {
                        port.write(`SET_DISTANCE:${data.settings.sensitivity}\n`);
                    }
                }

                if (data.settings.safeScreen !== undefined) {
                    currentSettings.safeScreen = data.settings.safeScreen;
                    updateAutoHotkeyConfig(data.settings.safeScreen);
                }

                if (data.settings.cooldown !== undefined) {
                    currentSettings.cooldown = data.settings.cooldown;
                    if (port && port.isOpen) {
                        port.write(`SET_COOLDOWN:${data.settings.cooldown}\n`);
                    }
                }

                saveSettings();
                broadcastSettings();
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
        }
    });
});

// Broadcast to all connected WebSocket clients
function broadcast(data) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function broadcastStatus() {
    broadcast({
        type: 'status',
        data: {
            systemActive: CONFIG.systemActive,
            lastDetection: lastDetectionTime ? new Date(lastDetectionTime).toLocaleString() : 'None',
            transmitterConnected: transmitterConnected,
            battery: batteryStatus,
            pendingCommands: pendingCommands.length,
            errorState: errorState
        }
    });
}

function broadcastSettings() {
    broadcast({
        type: 'settings',
        data: currentSettings
    });
}

function broadcastLog(log) {
    broadcast({
        type: 'newLog',
        data: log
    });
}

// Global variables
let port;
let detectionLogs = [];
let lastDetectionTime = null;
let transmitterConnected = false;
let currentSettings = {
    sensitivity: 20,  // Default distance in cm
    safeScreen: 'study',
    cooldown: 10  // Default cooldown in seconds
};

// Try to load settings from file
try {
    const savedSettings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
    currentSettings = { ...currentSettings, ...savedSettings };
    console.log('Loaded settings:', currentSettings);
} catch (error) {
    // No settings file or invalid - use defaults
    console.log('Using default settings');
}

// Create AutoHotkey config file
function updateAutoHotkeyConfig(safeScreen) {
    const configContent = `[Settings]\nSafeAction=${safeScreen}\n`;
    fs.writeFileSync('config.ini', configContent);
}

// Make sure config exists
updateAutoHotkeyConfig(currentSettings.safeScreen);

// Save settings to file
function saveSettings() {
    fs.writeFileSync('settings.json', JSON.stringify(currentSettings, null, 2));
}

// Initialize serial port
try {
    port = new SerialPort({
        path: CONFIG.comPort,
        baudRate: CONFIG.baudRate
    });
    console.log(`Connected to ${CONFIG.comPort} at ${CONFIG.baudRate} baud`);

    // Check transmitter connection every 10 seconds
    setInterval(() => {
        if (port && port.isOpen) {
            port.write("CHECK_CONNECTION\n");
        }
    }, 10000);

} catch (error) {
    console.error(`Failed to connect to serial port: ${error.message}`);
    port = null;
}

// Set up parser if port was initialized
let parser;
if (port) {
    parser = new ReadlineParser();
    port.pipe(parser);

    // Handle detection signals
    parser.on("data", (line) => {
        line = line.trim();

        if (line === "EVENT:STRANGER_DETECTED") {
            if (CONFIG.systemActive) {
                handleDetection("Stranger detected");
            } else {
                logMessage("Motion detected but system inactive - no action taken");
            }
        }
        else if (line === "STATUS:TRANSMITTER_CONNECTED") {
            transmitterConnected = true;
            logMessage("Transmitter connected");
            broadcastStatus();
        }
        else if (line === "STATUS:TRANSMITTER_DISCONNECTED" || line === "STATUS:TRANSMITTER_LOST") {
            transmitterConnected = false;
            logMessage("Transmitter disconnected");
            broadcastStatus();
        }
        else if (line === "HEARTBEAT:RECEIVED") {
            transmitterConnected = true;
            // No need to log regular heartbeats
        }
        else if (line.startsWith("BATTERY_LOW:")) {
            // Extract the battery percentage
            const batteryLevel = parseInt(line.split(':')[1]);
            const message = `Transmitter battery low: ${batteryLevel}%`;

            // Log the battery warning
            logMessage(message);

            // Update global state if needed
            const batteryStatus = {
                level: batteryLevel,
                isLow: true
            };

            // Broadcast battery status to all clients
            broadcast({
                type: 'batteryStatus',
                data: batteryStatus
            });
        }
        else if (line === "STATUS:RECEIVER_READY") {
            logMessage("Receiver hardware initialized");
        }
        else if (line === "STATUS:RECEIVER_ACTIVE") {
            logMessage("Receiver is active and listening");
        }
        else if (line.startsWith("ERROR:")) {
            // Handle error messages
            const errorMessage = line.substring(6); // Remove "ERROR:" prefix
            logMessage(`Error: ${errorMessage}`);

            // Broadcast error to clients
            broadcast({
                type: 'error',
                data: {
                    message: errorMessage,
                    timestamp: new Date().toISOString()
                }
            });
        }
        else if (line.startsWith("CMD_QUEUED:")) {
            const command = line.substring(11); // Remove "CMD_QUEUED:" prefix
            logMessage(`Command queued: ${command}`);
        }
        else if (line.startsWith("CMD_SENT:")) {
            const command = line.substring(9); // Remove "CMD_SENT:" prefix
            logMessage(`Command sent to transmitter: ${command}`);
        }
        else if (line === "ACK_TIMEOUT") {
            logMessage("Command acknowledgment timed out");
        }
        else if (line.startsWith("ACK_RECEIVED:")) {
            const ack = line.substring(13); // Remove "ACK_RECEIVED:" prefix
            logMessage(`Command acknowledged: ${ack}`);
        }
        else if (line.startsWith("QUEUE_STATUS:")) {
            const queueSize = parseInt(line.split(':')[1]);
            pendingCommands = new Array(queueSize).fill(null);  // Just to track count

            broadcast({
                type: 'commandQueue',
                data: {
                    size: queueSize
                }
            });
        }
        else {
            console.log(`Serial message: ${line}`);
        }
    });

    // Handle errors
    port.on('error', (err) => {
        console.error(`Serial port error: ${err.message}`);
        logMessage(`Error: Serial port - ${err.message}`);
    });
}

// Handle detection event
function handleDetection(message) {
    logMessage(message);
    lastDetectionTime = Date.now();
    broadcastStatus();

    // Execute the AutoHotkey script for screen switching
    exec(CONFIG.scriptPath, (error) => {
        if (error) {
            console.error(`Error executing script: ${error.message}`);
            logMessage(`Error: Failed to switch screen - ${error.message}`);
        } else {
            logMessage("Screen switched successfully");
        }
    });
}

// Log detection event
function logMessage(message) {
    const timestamp = new Date().toLocaleString();
    const logEntry = {
        timestamp,
        message
    };

    console.log(`${timestamp}: ${message}`);

    // Add to in-memory logs
    detectionLogs.push(logEntry);
    if (detectionLogs.length > 1000) {
        detectionLogs.shift(); // Remove oldest log if we have too many
    }

    // Broadcast to clients
    broadcastLog(logEntry);

    // Save to log file
    fs.appendFile(CONFIG.logFile, `${timestamp}: ${message}\n`, (err) => {
        if (err) {
            console.error(`Failed to write to log file: ${err.message}`);
        }
    });
}

// Clean up on exit
process.on('SIGINT', () => {
    console.log("Shutting down...");
    if (port && port.isOpen) {
        port.close();
    }
    saveSettings();
    process.exit();
});

// Start the server
server.listen(CONFIG.webPort, () => {
    console.log(`Stranger Detector dashboard running at http://localhost:${CONFIG.webPort}`);
    console.log(`System is ${CONFIG.systemActive ? 'active' : 'inactive'}`);
});

console.log("Stranger Detector monitoring started. Press Ctrl+C to exit.");