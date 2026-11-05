import AppKit
import Foundation

final class MenuAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var statusLine: NSMenuItem!
    private var toggleItem: NSMenuItem!
    private var pollItem: NSMenuItem!
    private var autostartItem: NSMenuItem!
    private var refreshTimer: Timer?
    private var serverProcess: Process?
    private var port: Int = 43110
    private var serverState: String = "启动中…"
    private var pollingEnabled = false
    private var busy = false
    private var autostartEnabled = false

    private var appPath: String {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        return executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
    }

    private var resourcesPath: String {
        return appPath + "/Contents/Resources"
    }

    private var dataDir: String {
        if let value = ProcessInfo.processInfo.environment["COURSE_NOTES_DATA_DIR"], !value.isEmpty {
            return value
        }
        return NSHomeDirectory() + "/Documents/course notes"
    }

    private var runtimePath: String {
        return dataDir + "/runtime.json"
    }

    private var baseURL: String {
        return "http://127.0.0.1:\(port)"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildMenu()
        loadPort()
        startServerIfNeeded()
        refreshStatus()
        refreshTimer = Timer.scheduledTimer(timeInterval: 3.0, target: self, selector: #selector(refreshStatus), userInfo: nil, repeats: true)
        if let timer = refreshTimer {
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    private func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let image = NSImage(systemSymbolName: "book.closed", accessibilityDescription: "course notes")
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.toolTip = "course notes"

        let menu = NSMenu()
        menu.autoenablesItems = false
        let header = NSMenuItem(title: "course notes", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        statusLine = NSMenuItem(title: "状态：启动中…", action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(NSMenuItem.separator())

        let openItem = NSMenuItem(title: "打开 course notes", action: #selector(openApp), keyEquivalent: "o")
        openItem.target = self
        menu.addItem(openItem)

        pollItem = NSMenuItem(title: "立即检测", action: #selector(pollNow), keyEquivalent: "r")
        pollItem.target = self
        menu.addItem(pollItem)

        toggleItem = NSMenuItem(title: "暂停轮询", action: #selector(togglePolling), keyEquivalent: "")
        toggleItem.target = self
        menu.addItem(toggleItem)

        let notesItem = NSMenuItem(title: "打开笔记目录", action: #selector(openNotes), keyEquivalent: "")
        notesItem.target = self
        menu.addItem(notesItem)

        menu.addItem(NSMenuItem.separator())
        autostartItem = NSMenuItem(title: "开机自启", action: #selector(toggleAutostart), keyEquivalent: "")
        autostartItem.target = self
        autostartItem.state = .off
        menu.addItem(autostartItem)

        menu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "退出 course notes", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    private func loadPort() {
        guard let data = FileManager.default.contents(atPath: runtimePath),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object["port"] as? Int else { return }
        port = value
    }

    private func startServerIfNeeded() {
        let node = resourcesPath + "/runtime/node"
        let script = resourcesPath + "/app/server/index.mjs"
        guard FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.fileExists(atPath: script) else {
            serverState = "组件缺失"
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script, "--no-open"]
        process.currentDirectoryURL = URL(fileURLWithPath: resourcesPath + "/app")
        var environment = ProcessInfo.processInfo.environment
        environment["COURSE_NOTES_DATA_DIR"] = dataDir
        environment["COURSE_NOTES_APP_PATH"] = appPath
        environment["COURSE_NOTES_PYTHON"] = resourcesPath + "/python/bin/python3"
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            serverProcess = process
        } catch {
            serverState = "启动失败"
        }
    }

    private func request(path: String, method: String = "GET", body: [String: Any]? = nil, completion: @escaping ([String: Any]?) -> Void) {
        guard let url = URL(string: baseURL + path) else {
            completion(nil)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 4
        if let body = body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        URLSession.shared.dataTask(with: request) { data, _, _ in
            DispatchQueue.main.async {
                guard let data = data,
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    completion(nil)
                    return
                }
                completion(object)
            }
        }.resume()
    }

    @objc private func refreshStatus() {
        loadPort()
        request(path: "/api/status") { [weak self] object in
            guard let self = self else { return }
            guard let object = object else {
                self.serverState = "服务未启动"
                self.statusLine.title = "状态：服务未启动"
                self.statusItem.button?.toolTip = "course notes · 服务未启动"
                return
            }
            if let value = object["port"] as? Int { self.port = value }
            self.pollingEnabled = (object["enabled"] as? Bool) ?? false
            self.busy = (object["busy"] as? Bool) ?? false
            self.serverState = self.busy ? "总结中" : (self.pollingEnabled ? "运行中" : "已暂停")
            self.statusLine.title = "状态：" + self.serverState
            self.toggleItem.title = self.pollingEnabled ? "暂停轮询" : "开始轮询"
            self.pollItem.isEnabled = !self.busy
            self.statusItem.button?.toolTip = "course notes · " + self.serverState
        }
        request(path: "/api/autostart") { [weak self] object in
            guard let self = self, let object = object, let state = object["autostart"] as? [String: Any] else { return }
            let enabled = (state["enabled"] as? Bool) ?? false
            let supported = (state["supported"] as? Bool) ?? false
            self.autostartEnabled = enabled
            self.autostartItem.state = enabled ? .on : .off
            self.autostartItem.isEnabled = supported
        }
    }

    @objc private func openApp() {
        startServerIfNeeded()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self = self, let url = URL(string: self.baseURL) else { return }
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func pollNow() {
        request(path: "/api/control", method: "POST", body: ["action": "pollNow"]) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    @objc private func togglePolling() {
        let action = pollingEnabled ? "stop" : "start"
        request(path: "/api/control", method: "POST", body: ["action": action]) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    @objc private func openNotes() {
        let folder = dataDir + "/课程知识地图"
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(URL(fileURLWithPath: folder))
    }

    @objc private func toggleAutostart() {
        let enabled = !autostartEnabled
        request(path: "/api/autostart", method: "POST", body: ["enabled": enabled]) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    @objc private func quitApp() {
        request(path: "/api/control", method: "POST", body: ["action": "shutdown"]) { _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                NSApp.terminate(nil)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            NSApp.terminate(nil)
        }
    }
}

let application = NSApplication.shared
let delegate = MenuAppDelegate()
application.delegate = delegate
application.run()
