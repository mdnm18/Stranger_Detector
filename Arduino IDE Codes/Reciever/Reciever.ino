#include <SPI.h>
#include <nRF24L01.h>
#include <RF24.h>

RF24 radio(9, 10); // CE, CSN pins
const byte address[6] = "00001";

unsigned long lastHeartbeatReceived = 0;
bool transmitterActive = false;

// Command forwarding and acknowledgment
#define MAX_COMMAND_QUEUE 5
String commandQueue[MAX_COMMAND_QUEUE];
int queueHead = 0;
int queueTail = 0;
unsigned long lastCommandSentTime = 0;
bool awaitingAck = false;

void setup()
{
  Serial.begin(9600);
  Serial.setTimeout(100); // Set timeout for serial reads

  // Initialize radio with retry logic
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
    Serial.println("ERROR:RADIO_INIT_FAILED");
    // Continue anyway, maybe it will work later
  }
  else
  {
    Serial.println("STATUS:RECEIVER_READY");
  }

  radio.openReadingPipe(0, address);
  radio.setPALevel(RF24_PA_MIN);
  radio.startListening();
}

void loop()
{
  // Check if there's a message from Serial (from Node.js)
  checkSerialCommands();

  // Process command queue
  processCommandQueue();

  // Check for incoming radio messages
  checkRadioMessages();

  // Check if transmitter has been silent for too long
  checkTransmitterTimeout();

  delay(50); // Small delay to prevent CPU hogging
}

void checkSerialCommands()
{
  if (Serial.available() > 0)
  {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "CHECK_CONNECTION")
    {
      if (millis() - lastHeartbeatReceived < 60000)
      { // If heartbeat received in last minute
        Serial.println("STATUS:TRANSMITTER_CONNECTED");
      }
      else
      {
        Serial.println("STATUS:TRANSMITTER_DISCONNECTED");
      }
    }
    else if (command.startsWith("SET_DISTANCE:"))
    {
      // Validate distance value
      String valueStr = command.substring(12);
      if (valueStr.length() > 0 && isStringNumeric(valueStr))
      {
        int distance = valueStr.toInt();
        if (distance >= 10 && distance <= 400)
        {
          // Queue command for forwarding to transmitter
          String fwdCommand = "DISTANCE:" + valueStr;
          addToCommandQueue(fwdCommand);
          Serial.println("CMD_QUEUED:SET_DISTANCE");
        }
        else
        {
          Serial.println("ERROR:INVALID_DISTANCE_RANGE");
        }
      }
      else
      {
        Serial.println("ERROR:INVALID_DISTANCE_VALUE");
      }
    }
    else if (command.startsWith("SET_COOLDOWN:"))
    {
      // Validate cooldown value
      String valueStr = command.substring(12);
      if (valueStr.length() > 0 && isStringNumeric(valueStr))
      {
        int cooldown = valueStr.toInt();
        if (cooldown >= 5 && cooldown <= 60)
        {
          // Queue command for forwarding to transmitter
          String fwdCommand = "COOLDOWN:" + valueStr;
          addToCommandQueue(fwdCommand);
          Serial.println("CMD_QUEUED:SET_COOLDOWN");
        }
        else
        {
          Serial.println("ERROR:INVALID_COOLDOWN_RANGE");
        }
      }
      else
      {
        Serial.println("ERROR:INVALID_COOLDOWN_VALUE");
      }
    }
    else if (command.startsWith("SET_CONFIRMATION:"))
    {
      String valueStr = command.substring(16);
      valueStr.toLowerCase();
      if (valueStr == "on" || valueStr == "off" || valueStr == "true" || valueStr == "false" || valueStr == "1" || valueStr == "0")
      {
        // Queue command for forwarding to transmitter
        String fwdCommand = "CONFIRMATION:" + valueStr;
        addToCommandQueue(fwdCommand);
        Serial.println("CMD_QUEUED:SET_CONFIRMATION");
      }
      else
      {
        Serial.println("ERROR:INVALID_CONFIRMATION_VALUE");
      }
    }
    else if (command == "GET_STATUS")
    {
      Serial.println("STATUS:RECEIVER_ACTIVE");
      Serial.print("QUEUE_STATUS:");
      Serial.println(getQueueSize());
    }
  }
}

void checkRadioMessages()
{
  if (radio.available())
  {
    char text[32] = "";
    radio.read(&text, sizeof(text));

    String message = String(text);

    if (message == "TRANSMITTER_HEARTBEAT")
    {
      lastHeartbeatReceived = millis();
      transmitterActive = true;
      Serial.println("HEARTBEAT:RECEIVED");
    }
    else if (message == "TRANSMITTER_ACTIVE")
    {
      lastHeartbeatReceived = millis();
      transmitterActive = true;
      Serial.println("STATUS:TRANSMITTER_CONNECTED");
    }
    else if (message == "STRANGER_DETECTED")
    {
      // Send detection event to Serial for Node.js to pick up
      Serial.println("EVENT:STRANGER_DETECTED");
    }
    else if (message.startsWith("ACK:"))
    {
      awaitingAck = false;
      Serial.print("ACK_RECEIVED:");
      Serial.println(message.substring(4));
    }
    else if (message.startsWith("BATTERY_LOW:"))
    {
      // Forward battery warning to Node.js
      Serial.println(message);
    }
    else
    {
      // Unknown message - forward it anyway
      Serial.print("MESSAGE:");
      Serial.println(message);
    }
  }
}

void checkTransmitterTimeout()
{
  if (transmitterActive && (millis() - lastHeartbeatReceived > 90000))
  { // 90 seconds
    transmitterActive = false;
    Serial.println("STATUS:TRANSMITTER_LOST");
  }
}

void processCommandQueue()
{
  // If there are commands in the queue and we're not waiting for an ACK
  if (queueHead != queueTail && !awaitingAck)
  {
    // If the transmitter is active
    if (transmitterActive)
    {
      // If enough time has passed since last command
      if (millis() - lastCommandSentTime > 1000)
      {
        // Switch to transmit mode
        radio.stopListening();

        // Get the next command from queue
        String command = commandQueue[queueHead];
        queueHead = (queueHead + 1) % MAX_COMMAND_QUEUE;

        // Send the command
        char buffer[32];
        command.toCharArray(buffer, 32);
        radio.write(&buffer, strlen(buffer) + 1);

        // Switch back to receive mode
        radio.startListening();

        // Update tracking variables
        lastCommandSentTime = millis();
        awaitingAck = true;

        Serial.print("CMD_SENT:");
        Serial.println(command);
      }
    }
    // If no ACK for too long, clear the waiting flag and try next command
    else if (millis() - lastCommandSentTime > 5000)
    {
      awaitingAck = false;
      Serial.println("ACK_TIMEOUT");
    }
  }
}

void addToCommandQueue(String command)
{
  // Check if queue is full
  if ((queueTail + 1) % MAX_COMMAND_QUEUE == queueHead)
  {
    Serial.println("ERROR:COMMAND_QUEUE_FULL");
    return;
  }

  // Add to queue
  commandQueue[queueTail] = command;
  queueTail = (queueTail + 1) % MAX_COMMAND_QUEUE;
}

int getQueueSize()
{
  if (queueHead <= queueTail)
  {
    return queueTail - queueHead;
  }
  else
  {
    return MAX_COMMAND_QUEUE - queueHead + queueTail;
  }
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