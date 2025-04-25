#define ECHO_PIN 2
#define TRIG_PIN 3
#define PIR_PIN 4
#define BATTERY_PIN A0                // For battery monitoring
#define DEFAULT_DETECTION_DISTANCE 20 // Default distance threshold in cm
#define DEFAULT_COOLDOWN_PERIOD 10000 // Default cooldown in milliseconds
#define PIR_SENSITIVITY_DELAY 500     // Time to wait for PIR confirmation in ms

#include <SPI.h>
#include <nRF24L01.h>
#include <RF24.h>
#include <EEPROM.h>

// Settings stored in EEPROM
struct Settings
{
  int detectionDistance;     // in cm
  long cooldownPeriod;       // in ms
  bool confirmationRequired; // Require both PIR and ultrasonic to trigger
};

RF24 radio(9, 10); // CE, CSN pins
const byte address[6] = "00001";
bool motionDetected = false;
unsigned long lastTriggerTime = 0;
unsigned long pirDetectedTime = 0;
Settings settings;

// EEPROM addresses
#define EEPROM_INITIALIZED_ADDR 0
#define SETTINGS_ADDR 1

// Message acknowledgment
bool awaitingAck = false;
unsigned long lastCommandSent = 0;
const char *lastCommand = NULL;
const int MAX_RETRIES = 3;
int retryCount = 0;

void setup()
{
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(PIR_PIN, INPUT);
  pinMode(BATTERY_PIN, INPUT);
  Serial.begin(9600);
  Serial.setTimeout(100); // Set timeout for serial reads

  // Load settings from EEPROM or use defaults
  loadSettings();

  // Initialize radio
  bool radioInitialized = false;
  for (int i = 0; i < 5; i++)
  { // Try 5 times to initialize
    if (radio.begin())
    {
      radioInitialized = true;
      break;
    }
    delay(1000);
  }

  if (!radioInitialized)
  {
    Serial.println("Radio hardware not responding!");
    // Continue anyway, maybe it will work later
  }

  radio.openWritingPipe(address);
  radio.setPALevel(RF24_PA_MIN); // Use minimum power level to start
  radio.stopListening();

  // Print debug info
  Serial.println("Transmitter initialized with settings:");
  Serial.print("Detection distance: ");
  Serial.print(settings.detectionDistance);
  Serial.println(" cm");
  Serial.print("Cooldown period: ");
  Serial.print(settings.cooldownPeriod / 1000);
  Serial.println(" seconds");
  Serial.print("Confirmation required: ");
  Serial.println(settings.confirmationRequired ? "Yes" : "No");

  // Report battery level
  int batteryLevel = readBatteryLevel();
  Serial.print("Battery level: ");
  Serial.print(batteryLevel);
  Serial.println("%");

  // Send a startup message
  const char startupMsg[] = "TRANSMITTER_ACTIVE";
  radio.write(&startupMsg, sizeof(startupMsg));
}

void loop()
{
  // Check if there's a command from serial
  checkForCommands();

  // Check for command acknowledgment timeout
  checkAckTimeout();

  // Read PIR sensor
  int pirValue = digitalRead(PIR_PIN);

  // Check if motion was detected by PIR sensor
  if (pirValue == HIGH)
  {
    pirDetectedTime = millis();
    motionDetected = true;
    Serial.println("Motion detected by PIR sensor");
  }

  // If PIR triggered or we're doing continuous monitoring, check ultrasonic
  if (motionDetected)
  {
    int distance = measureDistance();
    Serial.print("Distance: ");
    Serial.print(distance);
    Serial.println(" cm");

    // Verify if object is close enough
    if (distance < settings.detectionDistance)
    {
      unsigned long currentTime = millis();
      // Check cooldown period
      if (currentTime - lastTriggerTime > settings.cooldownPeriod)
      {

        // If confirmation required, check timing of PIR trigger
        bool confirmed = true;
        if (settings.confirmationRequired)
        {
          // Make sure PIR and ultrasonic triggers are within reasonable time of each other
          if (currentTime - pirDetectedTime > PIR_SENSITIVITY_DELAY)
          {
            confirmed = false;
            Serial.println("PIR and ultrasonic triggers too far apart, ignoring");
          }
        }

        if (confirmed)
        {
          Serial.println("Presence confirmed! Sending alert...");
          const char text[] = "STRANGER_DETECTED";

          // Try sending multiple times to ensure delivery
          for (int i = 0; i < 3; i++)
          {
            radio.write(&text, sizeof(text));
            delay(15); // Short delay between retries
          }

          lastTriggerTime = currentTime;
        }
      }
    }

    motionDetected = false; // Reset motion flag
  }

  // Periodically check battery level and report if low
  static unsigned long lastBatteryCheck = 0;
  unsigned long currentTime = millis();
  if (currentTime - lastBatteryCheck > 300000)
  { // Every 5 minutes
    int batteryLevel = readBatteryLevel();
    if (batteryLevel < 20)
    {
      // Battery low, send warning
      char batteryMsg[32];
      sprintf(batteryMsg, "BATTERY_LOW:%d", batteryLevel);
      radio.write(&batteryMsg, sizeof(batteryMsg));
      Serial.print("Low battery warning: ");
      Serial.print(batteryLevel);
      Serial.println("%");
    }
    lastBatteryCheck = currentTime;
  }

  // Occasionally send a heartbeat to confirm transmitter is working
  static unsigned long lastHeartbeat = 0;
  if (currentTime - lastHeartbeat > 30000)
  { // Every 30 seconds
    const char heartbeat[] = "TRANSMITTER_HEARTBEAT";
    radio.write(&heartbeat, sizeof(heartbeat));
    lastHeartbeat = currentTime;
  }

  delay(100); // Small delay between loops
}

int measureDistance()
{
  // Clear the trigger pin
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  // Trigger the sensor
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  // Read the echo pin
  long duration = pulseIn(ECHO_PIN, HIGH, 50000); // Add timeout to avoid hanging

  if (duration == 0)
  {
    // Timeout occurred - object is either too far or error
    return 400; // Return a large value
  }

  // Calculate distance
  return duration * 0.034 / 2;
}

void checkForCommands()
{
  if (Serial.available() > 0)
  {
    String command = Serial.readStringUntil('\n');
    command.trim();

    // Command parsing with better validation
    if (command.startsWith("DISTANCE:"))
    {
      String valueStr = command.substring(9);
      if (valueStr.length() > 0 && isStringNumeric(valueStr))
      {
        int newDistance = valueStr.toInt();
        if (newDistance >= 10 && newDistance <= 400)
        {
          settings.detectionDistance = newDistance;
          saveSettings();
          Serial.print("Detection distance updated to: ");
          Serial.println(newDistance);

          // Send acknowledgment
          sendAcknowledgment("DISTANCE_UPDATED");
        }
        else
        {
          Serial.println("ERROR: Distance must be between 10 and 400 cm");
        }
      }
      else
      {
        Serial.println("ERROR: Invalid distance value");
      }
    }
    else if (command.startsWith("COOLDOWN:"))
    {
      String valueStr = command.substring(9);
      if (valueStr.length() > 0 && isStringNumeric(valueStr))
      {
        long newCooldown = valueStr.toInt() * 1000; // Convert seconds to ms
        if (newCooldown >= 5000 && newCooldown <= 60000)
        {
          settings.cooldownPeriod = newCooldown;
          saveSettings();
          Serial.print("Cooldown period updated to: ");
          Serial.print(newCooldown / 1000);
          Serial.println(" seconds");

          // Send acknowledgment
          sendAcknowledgment("COOLDOWN_UPDATED");
        }
        else
        {
          Serial.println("ERROR: Cooldown must be between 5 and 60 seconds");
        }
      }
      else
      {
        Serial.println("ERROR: Invalid cooldown value");
      }
    }
    else if (command.startsWith("CONFIRMATION:"))
    {
      String valueStr = command.substring(13);
      valueStr.toLowerCase();
      if (valueStr == "on" || valueStr == "true" || valueStr == "1")
      {
        settings.confirmationRequired = true;
        saveSettings();
        Serial.println("Confirmation requirement enabled");
        sendAcknowledgment("CONFIRMATION_ENABLED");
      }
      else if (valueStr == "off" || valueStr == "false" || valueStr == "0")
      {
        settings.confirmationRequired = false;
        saveSettings();
        Serial.println("Confirmation requirement disabled");
        sendAcknowledgment("CONFIRMATION_DISABLED");
      }
      else
      {
        Serial.println("ERROR: Invalid confirmation value (use ON/OFF)");
      }
    }
    else if (command == "STATUS")
    {
      Serial.println("Transmitter status:");
      Serial.print("Detection distance: ");
      Serial.print(settings.detectionDistance);
      Serial.println(" cm");
      Serial.print("Cooldown period: ");
      Serial.print(settings.cooldownPeriod / 1000);
      Serial.println(" seconds");
      Serial.print("Confirmation required: ");
      Serial.println(settings.confirmationRequired ? "Yes" : "No");

      // Report battery level
      int batteryLevel = readBatteryLevel();
      Serial.print("Battery level: ");
      Serial.print(batteryLevel);
      Serial.println("%");
    }
    else if (command == "ACK")
    {
      // Received acknowledgment from receiver
      awaitingAck = false;
      retryCount = 0;
    }
  }
}

void sendAcknowledgment(const char *message)
{
  char ackMsg[32];
  sprintf(ackMsg, "ACK:%s", message);

  // Try sending the acknowledgment
  for (int i = 0; i < 2; i++)
  {
    radio.write(&ackMsg, sizeof(ackMsg));
    delay(10);
  }
}

void checkAckTimeout()
{
  // If we're waiting for an ACK and it's been too long
  if (awaitingAck && (millis() - lastCommandSent > 2000))
  {
    if (retryCount < MAX_RETRIES)
    {
      // Retry the command
      retryCount++;
      radio.write(lastCommand, strlen(lastCommand) + 1);
      lastCommandSent = millis();
      Serial.print("Retrying command, attempt ");
      Serial.println(retryCount);
    }
    else
    {
      // Give up
      Serial.println("Failed to get acknowledgment after max retries");
      awaitingAck = false;
      retryCount = 0;
    }
  }
}

void loadSettings()
{
  // Check if EEPROM has been initialized
  byte initialized = EEPROM.read(EEPROM_INITIALIZED_ADDR);

  if (initialized == 123)
  { // Magic number to check if initialized
    // Read settings from EEPROM
    EEPROM.get(SETTINGS_ADDR, settings);
  }
  else
  {
    // Use default settings
    settings.detectionDistance = DEFAULT_DETECTION_DISTANCE;
    settings.cooldownPeriod = DEFAULT_COOLDOWN_PERIOD;
    settings.confirmationRequired = true; // Default to requiring confirmation

    // Save defaults to EEPROM
    saveSettings();
    EEPROM.write(EEPROM_INITIALIZED_ADDR, 123); // Mark as initialized
  }
}

void saveSettings()
{
  EEPROM.put(SETTINGS_ADDR, settings);
}

// Helper function to check if a string contains only numbers
bool isStringNumeric(String str)
{
  for (unsigned int i = 0; i < str.length(); i++)
  {
    if (!isDigit(str.charAt(i)))
    {
      return false;
    }
  }
  return true;
}

// Read battery level as percentage
int readBatteryLevel()
{
  // Read analog value from battery monitoring pin
  // This implementation will depend on your specific hardware
  // Assuming a voltage divider with max reading of 1023 = 100%
  int rawValue = analogRead(BATTERY_PIN);

  // Map raw value to percentage
  // Adjust these values based on your battery and voltage divider
  int batteryPercent = map(rawValue, 614, 1023, 0, 100); // 614 ~= 3.0V, 1023 ~= 5.0V

  // Constrain to valid percentage range
  batteryPercent = constrain(batteryPercent, 0, 100);

  return batteryPercent;
}