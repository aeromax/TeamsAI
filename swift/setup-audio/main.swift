// swift/setup-audio/main.swift
// Compile: swiftc main.swift -o setup-audio
//
// Usage:
//   setup-audio setup     — creates Multi-Output Device (BlackHole + original output)
//   setup-audio teardown  — restores original default output device
//   setup-audio status    — prints current default output device name
//
// This binary automates what the user would normally do in Audio MIDI Setup.app.
// It creates a CoreAudio Aggregate Multi-Output Device so that:
//   - System audio plays through the user's speakers (or AirPods), AND
//   - BlackHole 2ch captures the same audio for transcription.

import Foundation
import CoreAudio
import AudioToolbox

// ── Helpers ───────────────────────────────────────────────────────────────────

func getDefaultOutputDeviceID() -> AudioDeviceID? {
    var deviceID = AudioDeviceID(kAudioObjectUnknown)
    var propSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let err = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &addr,
        0, nil,
        &propSize, &deviceID
    )
    return err == noErr && deviceID != kAudioObjectUnknown ? deviceID : nil
}

func setDefaultOutputDevice(_ deviceID: AudioDeviceID) -> Bool {
    var id = deviceID
    let propSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let err = AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &addr,
        0, nil,
        propSize, &id
    )
    return err == noErr
}

func getDeviceName(_ deviceID: AudioDeviceID) -> String {
    var unmanaged: Unmanaged<CFString>? = nil
    var propSize = UInt32(MemoryLayout<Unmanaged<CFString>>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &propSize, &unmanaged)
    return (unmanaged?.takeRetainedValue() as String?) ?? ""
}

func getAllOutputDevices() -> [AudioDeviceID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var propSize: UInt32 = 0
    AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &propSize
    )
    let count = Int(propSize) / MemoryLayout<AudioDeviceID>.size
    var devices = Array(repeating: AudioDeviceID(kAudioObjectUnknown), count: count)
    AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &propSize, &devices
    )

    return devices.filter { deviceID in
        var streamAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        AudioObjectGetPropertyDataSize(deviceID, &streamAddr, 0, nil, &size)
        return size > 0
    }
}

func findBlackHoleDevice() -> AudioDeviceID? {
    getAllOutputDevices().first { getDeviceName($0).lowercased().contains("blackhole") }
}

// ── Persistence ───────────────────────────────────────────────────────────────

let stateDir = FileManager.default.urls(
    for: .applicationSupportDirectory, in: .userDomainMask
)[0].appendingPathComponent("TeamsAI")

let stateFile = stateDir.appendingPathComponent("audio-state.json")

func saveState(_ dict: [String: Any]) {
    try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
    if let data = try? JSONSerialization.data(withJSONObject: dict) {
        try? data.write(to: stateFile)
    }
}

func loadState() -> [String: Any]? {
    guard let data = try? Data(contentsOf: stateFile),
          let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return dict
}

// ── Multi-Output Device creation ──────────────────────────────────────────────

func createMultiOutputDevice(mainDeviceID: AudioDeviceID, blackholeID: AudioDeviceID) -> AudioDeviceID? {
    let mainUID = getDeviceUID(mainDeviceID)
    let bhUID = getDeviceUID(blackholeID)

    guard !mainUID.isEmpty, !bhUID.isEmpty else {
        print("ERROR: Could not retrieve device UIDs")
        return nil
    }

    let desc: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Teams AI Output",
        kAudioAggregateDeviceUIDKey: "com.teamsai.aggregate-output",
        kAudioAggregateDeviceSubDeviceListKey: [
            [kAudioSubDeviceUIDKey: mainUID, kAudioSubDeviceDriftCompensationKey: 0],
            [kAudioSubDeviceUIDKey: bhUID,   kAudioSubDeviceDriftCompensationKey: 1],
        ],
        kAudioAggregateDeviceMasterSubDeviceKey: mainUID,
        kAudioAggregateDeviceIsStackedKey: 1,  // Multi-Output (not aggregate)
    ]

    var aggregateID = AudioDeviceID(kAudioObjectUnknown)
    let err = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &aggregateID)
    guard err == noErr else {
        print("ERROR: AudioHardwareCreateAggregateDevice failed: \(err)")
        return nil
    }
    return aggregateID
}

func getDeviceUID(_ deviceID: AudioDeviceID) -> String {
    var unmanaged: Unmanaged<CFString>? = nil
    var propSize = UInt32(MemoryLayout<Unmanaged<CFString>>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &propSize, &unmanaged)
    return (unmanaged?.takeRetainedValue() as String?) ?? ""
}

func destroyAggregateDevice(_ deviceID: AudioDeviceID) {
    AudioHardwareDestroyAggregateDevice(deviceID)
}

// ── Commands ──────────────────────────────────────────────────────────────────

// Shared: tear down any existing Multi-Output Device, create a new one with
// mainDeviceID + BlackHole, set it as system default, and save state.
func buildAndActivate(mainDeviceID: AudioDeviceID, blackholeID: AudioDeviceID) {
    // Tear down existing aggregate if any (so we can rebuild with a different base)
    if let state = loadState() {
        let existingAggID = AudioDeviceID((state["aggregateDeviceID"] as? UInt32) ?? 0)
        if existingAggID != kAudioObjectUnknown && existingAggID != mainDeviceID {
            // Restore original so the aggregate is no longer the default before we destroy it
            let origID = AudioDeviceID((state["originalDeviceID"] as? UInt32) ?? 0)
            if origID != kAudioObjectUnknown { _ = setDefaultOutputDevice(origID) }
            Thread.sleep(forTimeInterval: 0.3)
            destroyAggregateDevice(existingAggID)
            Thread.sleep(forTimeInterval: 0.3)
        }
    }

    let mainName = getDeviceName(mainDeviceID)
    print("Building Multi-Output: \(mainName) + BlackHole")

    guard let aggregateID = createMultiOutputDevice(mainDeviceID: mainDeviceID, blackholeID: blackholeID) else {
        print("ERROR: Failed to create Multi-Output Device.")
        exit(1)
    }
    Thread.sleep(forTimeInterval: 0.5)
    guard setDefaultOutputDevice(aggregateID) else {
        print("ERROR: Failed to set Multi-Output Device as default.")
        destroyAggregateDevice(aggregateID)
        exit(1)
    }
    saveState([
        "originalDeviceID": mainDeviceID,
        "originalDeviceName": mainName,
        "aggregateDeviceID": aggregateID,
    ])
    print("SUCCESS: Audio plays through \(mainName) + captured by BlackHole.")
}

// setup — uses current system default output as the base device.
// Skips if a Multi-Output Device is already active with the same base.
func cmdSetup() {
    guard let blackholeID = findBlackHoleDevice() else {
        print("ERROR: BlackHole 2ch not found. Please install it first.")
        exit(1)
    }
    guard let originalID = getDefaultOutputDeviceID() else {
        print("ERROR: Could not determine current default output device.")
        exit(1)
    }
    let originalUID = getDeviceUID(originalID)
    if originalUID == "com.teamsai.aggregate-output" {
        print("Multi-Output Device already active.")
        exit(0)
    }
    buildAndActivate(mainDeviceID: originalID, blackholeID: blackholeID)
}

// setup-with <name-fragment> — rebuilds the Multi-Output Device using the named
// output device (e.g. "AirPods") as the base so the user can keep hearing through
// their preferred device while BlackHole captures the audio.
func cmdSetupWith(nameFragment: String) {
    guard let blackholeID = findBlackHoleDevice() else {
        print("ERROR: BlackHole 2ch not found.")
        exit(1)
    }
    let fragment = nameFragment.lowercased()
    let candidates = getAllOutputDevices().filter {
        let n = getDeviceName($0).lowercased()
        return n.contains(fragment) && !n.contains("blackhole") && !n.contains("teams ai")
    }
    guard let targetID = candidates.first else {
        print("WARNING: No output device matching '\(nameFragment)' found — using system default.")
        cmdSetup()
        return
    }
    print("Preferred device: \(getDeviceName(targetID))")
    buildAndActivate(mainDeviceID: targetID, blackholeID: blackholeID)
}

// list-outputs — prints all output devices (one per line) so the UI can populate
// the "Listen through" dropdown without needing a separate CoreAudio call.
func cmdListOutputs() {
    for id in getAllOutputDevices() {
        let name = getDeviceName(id)
        if !name.lowercased().contains("blackhole") && !name.lowercased().contains("teams ai") {
            print(name)
        }
    }
}

func cmdTeardown() {
    guard let state = loadState() else {
        print("No saved audio state found. Nothing to restore.")
        exit(0)
    }

    let originalID = AudioDeviceID((state["originalDeviceID"] as? UInt32) ?? 0)
    let aggregateID = AudioDeviceID((state["aggregateDeviceID"] as? UInt32) ?? 0)

    if originalID != kAudioObjectUnknown {
        if setDefaultOutputDevice(originalID) {
            print("Restored output to: \(state["originalDeviceName"] as? String ?? "unknown")")
        } else {
            print("WARNING: Could not restore original output device.")
        }
    }

    if aggregateID != kAudioObjectUnknown {
        Thread.sleep(forTimeInterval: 0.3)
        destroyAggregateDevice(aggregateID)
        print("Destroyed Multi-Output Device.")
    }

    try? FileManager.default.removeItem(at: stateFile)
    print("SUCCESS: Audio routing restored.")
}

func cmdStatus() {
    if let defaultID = getDefaultOutputDeviceID() {
        print("Default output: \(getDeviceName(defaultID)) (ID: \(defaultID))")
    } else {
        print("Could not determine default output device.")
    }

    if let bh = findBlackHoleDevice() {
        print("BlackHole: found (ID: \(bh))")
    } else {
        print("BlackHole: NOT found")
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "status"

switch command {
case "setup":
    cmdSetup()
case "setup-with":
    if args.count > 2 {
        cmdSetupWith(nameFragment: args[2])
    } else {
        print("Usage: setup-audio setup-with <device-name-fragment>")
        exit(1)
    }
case "list-outputs":
    cmdListOutputs()
case "teardown":
    cmdTeardown()
case "status":
    cmdStatus()
default:
    print("Usage: setup-audio <setup|setup-with <name>|list-outputs|teardown|status>")
    exit(1)
}
