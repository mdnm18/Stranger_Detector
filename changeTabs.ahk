; Stranger Detector - Screen Switcher
; This script switches to a "safe" application when triggered

; Read configuration from file
IniRead, SafeAction, %A_ScriptDir%\config.ini, Settings, SafeAction, study

; Define actions based on configuration
if (SafeAction = "study") {
    ; Open a study-related document or application
    Run, notepad.exe
    WinWait, Untitled - Notepad
    WinActivate
    SendInput,THE CODE BREAKERS are Working on their assignments....
} else if (SafeAction = "youtube") {
    ; Open YouTube in default browser
    Run, https://www.youtube.com/
} else if (SafeAction = "desktop") {
    ; Minimize all windows to show desktop
    Send, #d
} else {
    ; Default action - Alt+Tab to next window
    Send, !{Tab}
}

; Optional: Show a small notification
SplashTextOn, 200, 50, Privacy Guard, Screen switched!
Sleep, 1000
SplashTextOff