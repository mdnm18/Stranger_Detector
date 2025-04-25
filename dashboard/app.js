window.addEventListener('error', function (event) {
    console.error('Global error caught:', event.error);
});

// Global variables
let systemActive = true;
const logs = [];
let socket;
let isConnected = false;
let reconnectInterval = null;
const reconnectDelay = 5000; // 5 seconds between reconnection attempts

// Initialize the dashboard when the page loads
document.addEventListener('DOMContentLoaded', function () {
    // Set up event listeners
    document.getElementById('toggle-system').addEventListener('click', toggleSystem);
    document.getElementById('save-settings').addEventListener('click', saveSettings);
    document.getElementById('test-detection').addEventListener('click', testDetection);
    document.getElementById('clear-logs').addEventListener('click', clearLogs);
    document.getElementById('export-logs').addEventListener('click', exportLogs);

    // Connect to WebSocket server
    connectWebSocket();
});

// Connect to WebSocket
function connectWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const wsUrl = `${wsProtocol}//${host}:${port}`;

    console.log(`Attempting to connect to WebSocket at ${wsUrl}`);

    // Update connection status
    updateConnectionStatus('connecting');

    // Create WebSocket connection
    socket = new WebSocket(wsUrl);

    // Connection opened
    socket.addEventListener('open', function (event) {  
        console.log('Connected to WebSocket server');
        isConnected = true;
        updateConnectionStatus('connected');

        // Clear any reconnection attempts
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
    });

    // Listen for messages
    socket.addEventListener('message', function (event) {
        const data = JSON.parse(event.data);
        handleServerMessage(data);
    });

    // Connection closed
    socket.addEventListener('close', function (event) {
        console.log('Disconnected from WebSocket server');
        isConnected = false;
        updateConnectionStatus('disconnected');

        // Set up reconnection
        if (!reconnectInterval) {
            reconnectInterval = setInterval(connectWebSocket, reconnectDelay);
        }
    });

    // Connection error
    socket.addEventListener('error', function (event) {
        console.error('WebSocket error details:', event);
        console.error('WebSocket error message:', event.message || 'No specific error message available');
        updateConnectionStatus('disconnected');
    });
}

function updateBatteryStatus(batteryData) {
    const batteryDisplay = document.getElementById('battery-status');
    if (!batteryDisplay) return;

    batteryDisplay.textContent = `${batteryData.level}%`;

    if (batteryData.isLow) {
        batteryDisplay.className = 'status-warning';
        // Maybe also show an alert or notification
        if (batteryData.level < 15) {
            showNotification('Critical Battery Level!',
                `Transmitter battery at ${batteryData.level}%. Please replace batteries soon.`);
        }
    } else {
        batteryDisplay.className = 'status-active';
    }
}

function displayError(errorData) {
    const errorDisplay = document.getElementById('error-status');
    if (!errorDisplay) return;

    errorDisplay.textContent = errorData.message;
    errorDisplay.style.display = 'block';

    // Hide after 10 seconds
    setTimeout(() => {
        errorDisplay.style.display = 'none';
    }, 10000);

    // Also add to logs
    addLocalLog({
        timestamp: errorData.timestamp,
        message: `ERROR: ${errorData.message}`
    });
}

function updateCommandQueue(queueData) {
    const queueDisplay = document.getElementById('command-queue');
    if (!queueDisplay) return;

    queueDisplay.textContent = queueData.size > 0 ?
        `${queueData.size} pending` : 'None';
}

// Update connection status display
function updateConnectionStatus(status) {
    const indicator = document.getElementById('connection-indicator');
    const text = document.getElementById('connection-text');

    indicator.className = '';

    switch (status) {
        case 'connected':
            indicator.classList.add('connected');
            text.textContent = 'Connected';
            break;
        case 'disconnected':
            indicator.classList.add('disconnected');
            text.textContent = 'Disconnected - Reconnecting...';
            break;
        case 'connecting':
            text.textContent = 'Connecting...';
            break;
    }
}

// Handle messages from the server
function handleServerMessage(data) {
    console.log('Received message:', data);

    switch (data.type) {
        case 'status':
            updateStatus(data.data);
            break;
        case 'logs':
            updateLogs(data.data);
            break;
        case 'newLog':
            addServerLog(data.data);
            break;
        case 'settings':
            updateSettings(data.data);
            break;
        case 'batteryStatus':
            updateBatteryStatus(data.data);
            break;
        case 'error':
            displayError(data.data);
            break;
        case 'commandQueue':
            updateCommandQueue(data.data);
            break;
    }
}

// Update status information
function updateStatus(statusData) {
    const detectorStatus = document.getElementById('detector-status');
    const lastDetection = document.getElementById('last-detection');
    const transmitterStatus = document.getElementById('transmitter-status');
    const toggleButton = document.getElementById('toggle-system');

    // Update system active status
    systemActive = statusData.systemActive;
    if (systemActive) {
        detectorStatus.textContent = 'Active';
        detectorStatus.className = 'status-active';
        toggleButton.textContent = 'Pause Detection';
        toggleButton.style.backgroundColor = '#e74c3c';
    } else {
        detectorStatus.textContent = 'Inactive';
        detectorStatus.className = 'status-inactive';
        toggleButton.textContent = 'Resume Detection';
        toggleButton.style.backgroundColor = '#2ecc71';
    }

    // Update last detection time
    lastDetection.textContent = statusData.lastDetection || 'None';

    // Update transmitter status
    if (statusData.transmitterConnected) {
        transmitterStatus.textContent = 'Connected';
        transmitterStatus.className = 'status-active';
    } else {
        transmitterStatus.textContent = 'Disconnected';
        transmitterStatus.className = 'status-inactive';
    }
}

// Update settings display
function updateSettings(settingsData) {
    document.getElementById('sensitivity').value = settingsData.sensitivity;
    document.getElementById('safe-screen').value = settingsData.safeScreen;
    document.getElementById('cooldown').value = settingsData.cooldown;

    // Update the displayed current screen
    document.getElementById('current-screen').textContent =
        document.getElementById('safe-screen').options[document.getElementById('safe-screen').selectedIndex].text;
}

// Update logs from server
function updateLogs(logsData) {
    // Clear existing logs
    logs.length = 0;
    const logsList = document.getElementById('detection-logs');
    logsList.innerHTML = '';

    // Add each log
    logsData.forEach(log => {
        addServerLog(log);
    });
}

// Add a log from the server
function addServerLog(log) {
    // Add to our in-memory logs array
    logs.unshift(log); // Add to beginning

    // Limit logs size
    if (logs.length > 100) {
        logs.pop(); // Remove oldest
    }

    // Create log entry for the UI
    const logsList = document.getElementById('detection-logs');
    const logItem = document.createElement('li');
    logItem.textContent = `${log.message} (${new Date(log.timestamp).toLocaleTimeString()})`;

    // Add to beginning of list
    if (logsList.firstChild) {
        logsList.insertBefore(logItem, logsList.firstChild);
    } else {
        logsList.appendChild(logItem);
    }

    // Keep UI list at a reasonable size
    while (logsList.children.length > 20) {
        logsList.removeChild(logsList.lastChild);
    }
}

// Toggle system active state
function toggleSystem() {
    if (!isConnected) {
        alert('Not connected to server. Please wait for connection to be established.');
        return;
    }

    systemActive = !systemActive;

    // Send toggle command to server
    socket.send(JSON.stringify({
        type: 'toggleSystem',
        active: systemActive
    }));

    // UI will be updated when server confirms the change
}

// Save settings to server
function saveSettings() {
    if (!isConnected) {
        alert('Not connected to server. Please wait for connection to be established.');
        return;
    }

    const sensitivity = document.getElementById("sensitivity").value;
    const safeScreen = document.getElementById("safe-screen").value;
    const cooldown = document.getElementById("cooldown").value;

    // Send settings to server
    socket.send(JSON.stringify({
        type: 'updateSettings',
        settings: {
            sensitivity: parseInt(sensitivity),
            safeScreen: safeScreen,
            cooldown: parseInt(cooldown)
        }
    }));
}

// Test the detection system
function testDetection() {
    if (!isConnected) {
        alert('Not connected to server. Please wait for connection to be established.');
        return;
    }

    if (!systemActive) {
        alert('System is inactive. Please activate it first.');
        return;
    }

    // Send test detection command to server
    socket.send(JSON.stringify({
        type: 'testDetection'
    }));
}

// Clear all logs
function clearLogs() {
    logs.length = 0;
    const logsList = document.getElementById('detection-logs');
    logsList.innerHTML = '';
}

// Export logs to a text file
function exportLogs() {
    if (logs.length === 0) {
        alert('No logs to export');
        return;
    }

    // Format logs for export
    const logText = logs.map(log =>
        `${new Date(log.timestamp).toLocaleString()}: ${log.message}`
    ).join('\n');

    const blob = new Blob([logText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `stranger-detector-logs-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}