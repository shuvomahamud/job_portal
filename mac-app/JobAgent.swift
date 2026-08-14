// JobAgent — menu bar app that starts and stops the Job Portal worker.
//
// Build with mac-app/build.sh, which substitutes the __REPO_DIR__ and __NODE_BIN__
// placeholders below. GUI apps do not inherit the shell PATH, so nvm's node is never
// discoverable at runtime; the absolute path has to be baked in at build time.

import AppKit
import Foundation
import UserNotifications

let repoDir = "__REPO_DIR__"
let nodeBin = "__NODE_BIN__"

enum WorkerState {
    case stopped
    case running
    case stopping
}

// MARK: - Configuration keys

enum Key {
    static let dashboardURL = "DASHBOARD_BASE_URL"
    static let databaseURL = "DATABASE_URL"
    static let apiSecret = "WORKER_API_SECRET"
    static let ownerUserID = "WORKER_OWNER_USER_ID"
    static let commandTypes = "WORKER_COMMAND_TYPES"

    static let browserProfile = "JOB_BROWSER_USER_DATA_DIR"
    static let browserHeadless = "JOB_BROWSER_HEADLESS"
    static let browserDiscovery = "JOB_BROWSER_DISCOVERY_ENABLED"
    static let browserChannel = "JOB_BROWSER_CHANNEL"
    static let browserCDPURL = "JOB_BROWSER_CDP_URL"
    static let browserCDPManagePages = "JOB_BROWSER_CDP_MANAGE_PAGES"

    static let ollamaURL = "OLLAMA_BASE_URL"
    static let ollamaModel = "OLLAMA_MODEL"

    static let applyEnabled = "JOB_APPLY_ENABLED"
    static let applyMode = "JOB_APPLY_MODE"
    static let applyMaxPerRun = "JOB_APPLY_MAX_PER_RUN"
    static let applyArtifacts = "JOB_APPLY_ARTIFACT_DIR"

    // A macOS notification never leaves the Mac — Apple Watch mirrors the iPhone, not this
    // machine. These send the same alerts to a phone through ntfy.
    static let pushEnabled = "JOB_APPLY_PUSH_ENABLED"
    static let ntfyTopic = "NTFY_TOPIC"

    static let resumeStore = "JOB_RESUME_STORE_DIR"
}

// MARK: - Resumes

struct ResumeEntry {
    let id: String
    let name: String
    let isDefault: Bool
    let chars: Int?
    let extractionError: String?
    let storagePath: String?
    let sizeBytes: Int?

    /// Mirrors isResumeHealthyForActivation in src/lib/resumeHealth.ts.
    var status: String {
        if storagePath == nil { return "No file — re-add it" }
        if let extractionError { return "Extraction failed: \(extractionError)" }
        guard let chars else { return "Text not extracted yet" }
        if chars < 800 { return "Thin extraction (\(chars) characters)" }
        return "Ready — \(chars) characters"
    }

    var isHealthy: Bool {
        storagePath != nil && extractionError == nil && (chars ?? 0) >= 800
    }
}

/// Message from the resume helper, surfaced verbatim in the UI.
struct ServiceError: Error {
    let message: String
}

/// Native macOS notifications, replacing the old Telegram channel.
enum Notifier {
    /// Must match DESKTOP_NOTIFY_PREFIX in worker/src/notify/desktopChannel.ts.
    static let prefix = "@@JOBAGENT_NOTIFY@@"

    private static var authorized = false

    static func requestPermission() {
        UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound]) { granted, _ in
                authorized = granted
            }
    }

    static func post(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}

/// Runs one of the repo's helper scripts and decodes the JSON it prints.
///
/// The app has no database driver of its own, so anything needing the database goes through
/// a tsx script. Progress text goes to stderr, leaving stdout as a clean JSON payload.
enum ScriptRunner {
    static func run(
        _ script: String,
        _ arguments: [String],
        completion: @escaping (Result<[String: Any], ServiceError>) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: nodeBin)
            task.arguments = ["\(repoDir)/node_modules/.bin/tsx", script] + arguments
            task.currentDirectoryURL = URL(fileURLWithPath: repoDir)

            var env = ProcessInfo.processInfo.environment
            for (key, value) in ConfigStore.shared.values { env[key] = value }
            env["PATH"] = "\(URL(fileURLWithPath: nodeBin).deletingLastPathComponent().path):/usr/local/bin:/usr/bin:/bin"
            task.environment = env

            let out = Pipe()
            let err = Pipe()
            task.standardOutput = out
            task.standardError = err

            do {
                try task.run()
            } catch {
                DispatchQueue.main.async { completion(.failure(ServiceError(message: error.localizedDescription))) }
                return
            }

            let data = out.fileHandleForReading.readDataToEndOfFile()
            let errorText = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            task.waitUntilExit()

            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                let detail = errorText.trimmingCharacters(in: .whitespacesAndNewlines)
                DispatchQueue.main.async {
                    completion(.failure(ServiceError(message: detail.isEmpty ? "The resume helper returned no output." : detail)))
                }
                return
            }
            DispatchQueue.main.async {
                if json["ok"] as? Bool == true {
                    completion(.success(json))
                } else {
                    completion(.failure(ServiceError(message: json["error"] as? String ?? "Unknown error")))
                }
            }
        }
    }

}

/// Dashboard user row, used to fill in the owner user ID.
struct DashboardUser {
    let id: String
    let email: String
    let name: String?
    let isLikelyTestAccount: Bool

    var display: String { name.map { "\($0) — \(email)" } ?? email }
}

enum UserService {
    static func list(completion: @escaping (Result<[DashboardUser], ServiceError>) -> Void) {
        ScriptRunner.run("worker/scripts/listUsers.ts", []) { result in
            switch result {
            case .failure(let error):
                completion(.failure(error))
            case .success(let json):
                let raw = json["users"] as? [[String: Any]] ?? []
                completion(.success(raw.map { item in
                    DashboardUser(
                        id: item["id"] as? String ?? "",
                        email: item["email"] as? String ?? "",
                        name: item["name"] as? String,
                        isLikelyTestAccount: item["isLikelyTestAccount"] as? Bool ?? false
                    )
                }))
            }
        }
    }
}

enum ResumeService {
    static func run(
        _ arguments: [String],
        completion: @escaping (Result<[String: Any], ServiceError>) -> Void
    ) {
        ScriptRunner.run("worker/scripts/manageResumes.ts", arguments, completion: completion)
    }

    static func list(completion: @escaping (Result<[ResumeEntry], ServiceError>) -> Void) {
        run(["list"]) { result in
            switch result {
            case .failure(let error):
                completion(.failure(error))
            case .success(let json):
                let raw = json["resumes"] as? [[String: Any]] ?? []
                completion(.success(raw.map { item in
                    ResumeEntry(
                        id: item["id"] as? String ?? "",
                        name: item["name"] as? String ?? "Untitled",
                        isDefault: item["isDefault"] as? Bool ?? false,
                        chars: item["resumeTextChars"] as? Int,
                        extractionError: item["extractionError"] as? String,
                        storagePath: item["storagePath"] as? String,
                        sizeBytes: item["sizeBytes"] as? Int
                    )
                }))
            }
        }
    }
}

/// Command types the worker dispatcher actually implements.
let allCommandTypes = [
    "find_matching_jobs",
    "run_job_search",
    "discover_jobs_browser",
    "import_jobs",
    "run_rule_filter",
    "run_local_llm_extraction",
    "sync_resume_text",
    "run_apply_cycle",
    "apply_to_jobs",
    "verify_submission",
    "open_browser_login",
]

let commandTypeLabels: [String: String] = [
    "find_matching_jobs": "Match jobs to my roles",
    "run_job_search": "Search job boards",
    "discover_jobs_browser": "Discover jobs in browser",
    "import_jobs": "Import job postings",
    "run_rule_filter": "Apply rule filters",
    "run_local_llm_extraction": "Extract details with local AI",
    "sync_resume_text": "Sync resume text",
    "run_apply_cycle": "Run the apply cycle",
    "apply_to_jobs": "Fill in applications",
    "verify_submission": "Verify submissions",
    "open_browser_login": "Open browser for login/CAPTCHA",
]

// MARK: - Configuration store

/// Worker configuration edited in the Settings tab.
///
/// Values are injected as real environment variables on the worker process. dotenv does not
/// overwrite variables that already exist, so anything set here wins over the repo's
/// .env.local, and .env.local still supplies whatever is left blank. That keeps the
/// Next.js/Vercel config in .env.local untouched.
final class ConfigStore {
    static let shared = ConfigStore()

    private(set) var values: [String: String] = [:]
    /// Keys present in .env.local, used to show what is already inherited.
    private(set) var inherited: Set<String> = []

    static let fileURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/JobAgent", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("worker.env")
    }()

    private init() {
        reload()
    }

    func reload() {
        let text = (try? String(contentsOf: Self.fileURL, encoding: .utf8)) ?? ""
        values = Self.parse(text)
        // One-time compatibility for settings saved by builds that used a daily quota.
        // The number is retained, but it now resets at the start of every apply run.
        if values[Key.applyMaxPerRun] == nil,
           let legacyLimit = values.removeValue(forKey: "JOB_APPLY_MAX_PER_DAY") {
            values[Key.applyMaxPerRun] = legacyLimit
        }
        if values.isEmpty { values = Self.defaults() }
        // Older saved configs predate the browser-engine field. Leaving the key absent
        // silently launches Playwright's Chrome for Testing, which Indeed repeatedly
        // challenges even after a human completes the checkbox. Preserve an explicit
        // "bundled" choice, but migrate a missing legacy value to installed Chrome.
        if values[Key.browserChannel] == nil {
            values[Key.browserChannel] = "chrome"
        }
        // The stable Mac topology launches a normal dedicated Chrome process and lets
        // Playwright attach over a loopback-only debugging port. This avoids Playwright's
        // automation-heavy browser launch flags, which Indeed rejects after a challenge.
        if values[Key.browserCDPURL] == nil {
            values[Key.browserCDPURL] = "http://127.0.0.1:9222"
        }
        if values[Key.browserCDPManagePages] == nil {
            values[Key.browserCDPManagePages] = "true"
        }
        if let configured = values[Key.commandTypes] {
            var commands = configured.split(separator: ",").map(String.init)
            if !commands.contains("open_browser_login") {
                commands.append("open_browser_login")
                values[Key.commandTypes] = commands.joined(separator: ",")
            }
        }

        let envLocal = URL(fileURLWithPath: repoDir).appendingPathComponent(".env.local")
        if let contents = try? String(contentsOf: envLocal, encoding: .utf8) {
            inherited = Set(Self.parse(contents).keys)
        } else {
            inherited = []
        }
    }

    static func defaults() -> [String: String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            Key.dashboardURL: "http://localhost:3000",
            Key.commandTypes: allCommandTypes.joined(separator: ","),
            Key.browserProfile: "\(home)/.job-worker-browser-profile",
            Key.browserHeadless: "false",
            // Installed Chrome passes bot checks that reject Playwright's bundled Chromium.
            Key.browserChannel: "chrome",
            Key.browserCDPURL: "http://127.0.0.1:9222",
            Key.browserCDPManagePages: "true",
            Key.browserDiscovery: "true",
            Key.ollamaURL: "http://127.0.0.1:11434",
            Key.ollamaModel: "qwen3.5:9b",
            Key.applyEnabled: "false",
            Key.applyMode: "dry_run",
            Key.applyMaxPerRun: "15",
            Key.applyArtifacts: "\(home)/.job-worker-artifacts",
        ]
    }

    func set(_ key: String, _ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { values.removeValue(forKey: key) } else { values[key] = trimmed }
    }

    func get(_ key: String) -> String { values[key] ?? "" }
    func bool(_ key: String) -> Bool { get(key) == "true" }

    /// True when the value is absent here but supplied by .env.local.
    func isInherited(_ key: String) -> Bool {
        values[key] == nil && inherited.contains(key)
    }

    /// A key counts as satisfied if this config sets it or .env.local provides it.
    func isSatisfied(_ key: String) -> Bool {
        !get(key).isEmpty || inherited.contains(key)
    }

    func save() throws {
        var lines = [
            "# JobAgent worker configuration.",
            "# Managed by the JobAgent app. Values here override the repo's .env.local;",
            "# anything omitted falls back to .env.local.",
            "",
        ]
        for key in values.keys.sorted() {
            guard let value = values[key], !value.isEmpty else { continue }
            lines.append("\(key)=\(value)")
        }
        try (lines.joined(separator: "\n") + "\n").write(to: Self.fileURL, atomically: true, encoding: .utf8)
        // Config holds secrets; keep it readable only by the current user.
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Self.fileURL.path)
    }

    /// Blocking problems that must be fixed before the worker can start.
    func blockingIssues() -> [String] {
        var issues: [String] = []
        if !isSatisfied(Key.dashboardURL) {
            issues.append("Dashboard URL is required")
        } else if URL(string: get(Key.dashboardURL).isEmpty ? "http://x" : get(Key.dashboardURL))?.scheme == nil {
            issues.append("Dashboard URL must start with http:// or https://")
        }
        if !isSatisfied(Key.databaseURL) { issues.append("Database URL is required") }
        if !isSatisfied(Key.apiSecret) {
            issues.append("Worker API secret is required")
        } else if !get(Key.apiSecret).isEmpty && get(Key.apiSecret).count < 16 {
            issues.append("Worker API secret must be at least 16 characters")
        }
        if selectedCommands().isEmpty { issues.append("Enable at least one task") }
        return issues
    }

    /// Non-blocking gaps worth surfacing before a run.
    func warnings() -> [String] {
        var result: [String] = []
        let applyCommands = ["run_apply_cycle", "apply_to_jobs", "verify_submission"]
        let usesApply = selectedCommands().contains { applyCommands.contains($0) }
        if usesApply && get(Key.ownerUserID).isEmpty {
            result.append("Owner user ID is empty — the apply cycle needs it")
        }
        if bool(Key.applyEnabled) && get(Key.applyMode) == "fill_and_submit" {
            result.append("Apply mode is fill_and_submit — applications will be submitted for real")
        }
        // A hidden browser reports itself as HeadlessChrome, which job site bot protection
        // rejects. There is no way to hide that and still run hidden.
        if bool(Key.browserHeadless) {
            result.append("Run hidden is on — job sites are more likely to show a “verify you are human” challenge")
        }
        if get(Key.browserChannel) == "bundled" {
            result.append("Browser engine is bundled Chromium — Google Chrome passes bot checks more reliably")
        }
        return result
    }

    func selectedCommands() -> [String] {
        get(Key.commandTypes)
            .components(separatedBy: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    func setCommands(_ commands: [String]) {
        set(Key.commandTypes, commands.joined(separator: ","))
    }

    /// Parses KEY=VALUE lines, tolerating `export` prefixes, wrapping quotes and comments.
    static func parse(_ text: String) -> [String: String] {
        var result: [String: String] = [:]
        for rawLine in text.components(separatedBy: .newlines) {
            var line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("export ") { line = String(line.dropFirst(7)) }
            guard let separator = line.firstIndex(of: "=") else { continue }

            let key = String(line[line.startIndex..<separator]).trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { continue }

            var value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
            if value.count >= 2,
               (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }
            // An empty value would shadow .env.local with a blank, so skip it.
            if value.isEmpty { continue }
            result[key] = value
        }
        return result
    }
}

// MARK: - Worker process

final class WorkerController {
    static let shared = WorkerController()

    private var process: Process?
    private var managedBrowserProcess: Process?
    private var logHandle: FileHandle?
    private(set) var state: WorkerState = .stopped

    var onStateChange: ((WorkerState) -> Void)?

    let logURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/JobAgent", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("worker.log")
    }()

    private func setState(_ next: WorkerState) {
        state = next
        DispatchQueue.main.async { [weak self] in self?.onStateChange?(next) }
    }

    private func appendLog(_ line: String) {
        let stamped = "[\(ISO8601DateFormatter().string(from: Date()))] \(line)\n"
        guard let data = stamped.data(using: .utf8) else { return }
        logHandle?.write(data)
    }

    private func cdpIsReachable(_ endpoint: URL) -> Bool {
        let versionURL = endpoint.appendingPathComponent("json/version")
        var request = URLRequest(url: versionURL)
        request.timeoutInterval = 0.75
        let semaphore = DispatchSemaphore(value: 0)
        var reachable = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse {
                reachable = (200..<300).contains(http.statusCode)
            }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1)
        return reachable
    }

    /// Starts a dedicated, ordinary Chrome instance for the worker and exposes CDP only
    /// on loopback. Playwright attaches later; it does not launch Chrome or add its long
    /// list of automation flags. The browser intentionally stays open across commands so
    /// job-site cookies, challenges, and login state keep one stable browser identity.
    private func ensureManagedBrowser() throws {
        let rawEndpoint = ConfigStore.shared.get(Key.browserCDPURL)
        guard !rawEndpoint.isEmpty else { return }
        guard let endpoint = URL(string: rawEndpoint),
              endpoint.scheme == "http",
              ["127.0.0.1", "localhost", "::1"].contains(endpoint.host ?? ""),
              let port = endpoint.port else {
            throw ServiceError(message: "Browser CDP URL must be a loopback HTTP URL with a port.")
        }
        if cdpIsReachable(endpoint) {
            appendLog("reusing dedicated Chrome on \(rawEndpoint)")
            return
        }

        let chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        guard FileManager.default.fileExists(atPath: chromePath) else {
            throw ServiceError(message: "Google Chrome is required at /Applications/Google Chrome.app")
        }
        let profile = ConfigStore.shared.get(Key.browserProfile)
        guard !profile.isEmpty else {
            throw ServiceError(message: "Browser profile folder is required.")
        }

        let chrome = Process()
        chrome.executableURL = URL(fileURLWithPath: chromePath)
        chrome.arguments = [
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=\(port)",
            "--user-data-dir=\(profile)",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ]
        chrome.standardOutput = FileHandle.nullDevice
        chrome.standardError = FileHandle.nullDevice
        try chrome.run()
        managedBrowserProcess = chrome

        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if cdpIsReachable(endpoint) {
                appendLog("started ordinary dedicated Chrome on \(rawEndpoint)")
                return
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        throw ServiceError(message: "Dedicated Chrome started, but its local debugging endpoint did not become ready.")
    }

    func start() {
        guard state == .stopped else { return }

        if !FileManager.default.fileExists(atPath: nodeBin) {
            notify(title: "Node not found", body: "Expected node at \(nodeBin). Rebuild with mac-app/build.sh.")
            return
        }
        let tsxPackage = "\(repoDir)/node_modules/tsx/package.json"
        if !FileManager.default.fileExists(atPath: tsxPackage) {
            notify(title: "Dependencies missing", body: "Run npm install in \(repoDir) first.")
            return
        }
        let issues = ConfigStore.shared.blockingIssues()
        if !issues.isEmpty {
            notify(title: "Settings incomplete", body: issues.joined(separator: "\n"))
            return
        }

        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        logHandle = try? FileHandle(forWritingTo: logURL)
        logHandle?.seekToEndOfFile()
        appendLog("--- starting worker ---")

        do {
            try ensureManagedBrowser()
        } catch {
            appendLog("failed to launch dedicated Chrome: \(error.localizedDescription)")
            notify(title: "Could not start browser", body: error.localizedDescription)
            try? logHandle?.close()
            logHandle = nil
            setState(.stopped)
            return
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: nodeBin)
        // Launch the runner directly in this Node process. The old .bin/tsx wrapper
        // spawned a grandchild that could survive when JobAgent exited or was replaced.
        task.arguments = ["--import", "tsx", "worker/src/runner.ts"]
        task.currentDirectoryURL = URL(fileURLWithPath: repoDir)

        // dotenv does not overwrite existing variables, so these take precedence over
        // .env.local while .env.local still fills in whatever is not set here.
        var env = ProcessInfo.processInfo.environment
        for (key, value) in ConfigStore.shared.values { env[key] = value }
        env["PATH"] = "\(URL(fileURLWithPath: nodeBin).deletingLastPathComponent().path):/usr/local/bin:/usr/bin:/bin"
        task.environment = env

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            self?.consumeWorkerOutput(data)
        }
        task.terminationHandler = { [weak self] finished in
            guard let self else { return }
            pipe.fileHandleForReading.readabilityHandler = nil
            self.appendLog("--- worker exited (status \(finished.terminationStatus)) ---")
            try? self.logHandle?.close()
            self.logHandle = nil
            self.process = nil
            self.setState(.stopped)
        }

        do {
            try task.run()
            process = task
            setState(.running)
        } catch {
            appendLog("failed to launch: \(error.localizedDescription)")
            notify(title: "Could not start", body: error.localizedDescription)
            try? logHandle?.close()
            logHandle = nil
            setState(.stopped)
        }
    }

    /// First call asks the worker to finish its current command and exit. Because an apply
    /// can legitimately run for many minutes, a second call kills it outright.
    func stop() {
        guard let task = process else { return }
        if state == .stopping {
            appendLog("--- force killing worker ---")
            kill(task.processIdentifier, SIGKILL)
            return
        }
        appendLog("--- stop requested (graceful) ---")
        setState(.stopping)
        kill(task.processIdentifier, SIGTERM)
    }

    /// App termination must not orphan a worker that can keep claiming commands after a
    /// replacement JobAgent starts. Give the direct Node runner a brief graceful window,
    /// then make the shutdown definitive.
    func shutdownForAppExit() {
        guard let task = process, task.isRunning else { return }
        appendLog("--- app exiting; stopping worker ---")
        kill(task.processIdentifier, SIGTERM)
        let deadline = Date().addingTimeInterval(2)
        while task.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if task.isRunning {
            appendLog("--- worker did not exit promptly; force killing ---")
            kill(task.processIdentifier, SIGKILL)
        }
    }

    func notify(title: String, body: String) {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = body
            alert.alertStyle = .warning
            alert.runModal()
        }
    }

    /// Splits worker output into notification lines and ordinary log lines.
    ///
    /// The worker emits a tagged JSON line when it wants the user's attention. Those become
    /// native notifications and are kept out of the log; everything else is logged as-is.
    private func consumeWorkerOutput(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8) else {
            logHandle?.write(data)
            return
        }

        var passthrough = ""
        for line in text.components(separatedBy: "\n") {
            guard let range = line.range(of: Notifier.prefix) else {
                if !line.isEmpty { passthrough += line + "\n" }
                continue
            }
            let payload = String(line[range.upperBound...])
            if let json = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
               let title = json["title"] as? String,
               let body = json["body"] as? String {
                Notifier.post(title: title, body: body)
                // Keep a plain record in the log so the activity view still shows it.
                passthrough += "[notification] \(title): \(body.replacingOccurrences(of: "\n", with: " — "))\n"
            }
        }
        if !passthrough.isEmpty, let out = passthrough.data(using: .utf8) {
            logHandle?.write(out)
        }
    }

    /// Last chunk of the log, for the live view on the Control tab.
    func recentLog(maxBytes: Int = 16_000) -> String {
        guard let handle = try? FileHandle(forReadingFrom: logURL) else { return "" }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let offset = size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0
        try? handle.seek(toOffset: offset)
        let data = (try? handle.readToEnd()) ?? Data()
        return String(data: data, encoding: .utf8) ?? ""
    }
}

// MARK: - Form helpers

func sectionHeader(_ title: String, subtitle: String? = nil) -> NSView {
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 2

    let label = NSTextField(labelWithString: title)
    label.font = .systemFont(ofSize: 13, weight: .semibold)
    stack.addArrangedSubview(label)

    if let subtitle {
        let sub = NSTextField(wrappingLabelWithString: subtitle)
        sub.font = .systemFont(ofSize: 11)
        sub.textColor = .secondaryLabelColor
        stack.addArrangedSubview(sub)
    }
    return stack
}

func formRow(_ label: String, _ control: NSView, hint: String? = nil) -> NSView {
    let labelField = NSTextField(labelWithString: label)
    labelField.alignment = .right
    labelField.font = .systemFont(ofSize: 12)
    labelField.translatesAutoresizingMaskIntoConstraints = false
    labelField.setContentHuggingPriority(.required, for: .horizontal)
    labelField.widthAnchor.constraint(equalToConstant: 150).isActive = true

    let right = NSStackView()
    right.orientation = .vertical
    right.alignment = .leading
    right.spacing = 2
    right.addArrangedSubview(control)
    if let hint {
        let hintField = NSTextField(wrappingLabelWithString: hint)
        hintField.font = .systemFont(ofSize: 10)
        hintField.textColor = .tertiaryLabelColor
        right.addArrangedSubview(hintField)
    }

    let row = NSStackView(views: [labelField, right])
    row.orientation = .horizontal
    row.alignment = .firstBaseline
    row.spacing = 10
    return row
}

// MARK: - Main window

final class MainWindowController: NSWindowController, NSTextFieldDelegate, NSTextViewDelegate,
                                  NSTableViewDataSource, NSTableViewDelegate {
    private let worker = WorkerController.shared
    private let config = ConfigStore.shared

    // Control tab
    private let statusDot = NSTextField(labelWithString: "●")
    private let statusTitle = NSTextField(labelWithString: "Stopped")
    private let statusDetail = NSTextField(labelWithString: "")
    private let startButton = NSButton(title: "Start Agent", target: nil, action: nil)
    private let stopButton = NSButton(title: "Stop Agent", target: nil, action: nil)
    private let checklistStack = NSStackView()
    private let runCycleButton = NSButton(title: "Run Cycle Now", target: nil, action: nil)
    private let logView = NSTextView()
    private var logTimer: Timer?

    // Settings controls
    private let dashboardField = NSTextField()
    private let databaseField = NSSecureTextField()
    private let secretField = NSSecureTextField()
    private let ownerField = NSTextField()
    private let profileField = NSTextField()
    private let headlessSwitch = NSSwitch()
    private let discoverySwitch = NSSwitch()
    private let browserEnginePopup = NSPopUpButton()
    private let ollamaURLField = NSTextField()
    private let ollamaModelField = NSTextField()
    private let applyEnabledSwitch = NSSwitch()
    private let applyModePopup = NSPopUpButton()
    private let applyRunLimitField = NSTextField()
    private let artifactsField = NSTextField()
    private let pushEnabledSwitch = NSSwitch()
    private let ntfyTopicField = NSTextField()
    private var commandBoxes: [String: NSButton] = [:]
    private let taskGrid = NSStackView()
    private let taskDisclosure = NSButton()
    private let taskSummary = NSTextField(labelWithString: "")
    private let saveStatus = NSTextField(labelWithString: "")

    // Resumes tab
    private let resumeTable = NSTableView()
    private let resumeStatus = NSTextField(labelWithString: "")
    private var resumes: [ResumeEntry] = []
    private let resumeStoreField = NSTextField()
    private var loginProcess: Process?

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 780, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "JobAgent"
        window.center()
        window.setFrameAutosaveName("JobAgentMain")
        super.init(window: window)

        let tabs = NSTabView()
        tabs.translatesAutoresizingMaskIntoConstraints = false

        let control = NSTabViewItem(identifier: "control")
        control.label = "Control"
        control.view = buildControlTab()
        tabs.addTabViewItem(control)

        let resumes = NSTabViewItem(identifier: "resumes")
        resumes.label = "Resumes"
        resumes.view = buildResumesTab()
        tabs.addTabViewItem(resumes)

        let settings = NSTabViewItem(identifier: "settings")
        settings.label = "Settings"
        settings.view = buildSettingsTab()
        tabs.addTabViewItem(settings)

        let content = NSView()
        content.addSubview(tabs)
        NSLayoutConstraint.activate([
            tabs.topAnchor.constraint(equalTo: content.topAnchor, constant: 12),
            tabs.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            tabs.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            tabs.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
        ])
        window.contentView = content

        loadIntoForm()
        worker.onStateChange = { [weak self] state in self?.render(state) }
        render(worker.state)
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    // MARK: Control tab

    private func buildControlTab() -> NSView {
        let root = NSView()

        statusDot.font = .systemFont(ofSize: 30)
        statusTitle.font = .systemFont(ofSize: 20, weight: .semibold)
        statusDetail.font = .systemFont(ofSize: 12)
        statusDetail.textColor = .secondaryLabelColor

        let textStack = NSStackView(views: [statusTitle, statusDetail])
        textStack.orientation = .vertical
        textStack.alignment = .leading
        textStack.spacing = 2

        let statusRow = NSStackView(views: [statusDot, textStack])
        statusRow.orientation = .horizontal
        statusRow.alignment = .centerY
        statusRow.spacing = 12

        startButton.target = self
        startButton.action = #selector(startTapped)
        startButton.bezelStyle = .rounded
        startButton.controlSize = .large
        startButton.keyEquivalent = "\r"

        stopButton.target = self
        stopButton.action = #selector(stopTapped)
        stopButton.bezelStyle = .rounded
        stopButton.controlSize = .large

        let buttons = NSStackView(views: [startButton, stopButton])
        buttons.orientation = .horizontal
        buttons.spacing = 10

        // Starting the agent only makes it listen; a cycle still has to be queued.
        // Which boards to search and how many to apply to are chosen per run on the
        // dashboard, so this button queues a default run rather than duplicating them.
        runCycleButton.target = self
        runCycleButton.action = #selector(runCycleNow)
        runCycleButton.bezelStyle = .rounded

        let cycleRow = NSStackView(views: [runCycleButton])
        cycleRow.orientation = .horizontal
        cycleRow.alignment = .centerY
        cycleRow.spacing = 8

        checklistStack.orientation = .vertical
        checklistStack.alignment = .leading
        checklistStack.spacing = 4

        let logScroll = NSScrollView()
        logScroll.hasVerticalScroller = true
        logScroll.borderType = .bezelBorder
        logScroll.translatesAutoresizingMaskIntoConstraints = false
        logView.isEditable = false
        logView.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        logView.isVerticallyResizable = true
        logView.autoresizingMask = [.width]
        logView.textContainer?.widthTracksTextView = true
        logScroll.documentView = logView

        let logHeader = NSTextField(labelWithString: "Activity")
        logHeader.font = .systemFont(ofSize: 12, weight: .semibold)

        let openLog = NSButton(title: "Open Full Log", target: self, action: #selector(openLogFile))
        openLog.bezelStyle = .rounded
        let openDash = NSButton(title: "Open Dashboard", target: self, action: #selector(openDashboard))
        openDash.bezelStyle = .rounded
        let loginButton = NSButton(title: "Log In to Job Sites…", target: self, action: #selector(openLogin))
        loginButton.bezelStyle = .rounded
        let footer = NSStackView(views: [loginButton, openDash, openLog])
        footer.orientation = .horizontal
        footer.spacing = 8

        let stack = NSStackView(views: [statusRow, buttons, cycleRow, checklistStack, logHeader])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        root.addSubview(logScroll)
        footer.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(footer)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),

            logScroll.topAnchor.constraint(equalTo: stack.bottomAnchor, constant: 6),
            logScroll.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            logScroll.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            logScroll.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -10),

            footer.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            footer.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -18),
            footer.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
        ])
        return root
    }

    // MARK: Resumes tab

    private func buildResumesTab() -> NSView {
        let root = NSView()

        let header = sectionHeader(
            "Your resumes",
            subtitle: "JobAgent keeps its own copy of every resume, so moving or deleting the original file cannot break an application."
        )
        header.translatesAutoresizingMaskIntoConstraints = false

        resumeTable.headerView = nil
        resumeTable.rowHeight = 46
        resumeTable.dataSource = self
        resumeTable.delegate = self
        resumeTable.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("resume")))
        resumeTable.style = .inset

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.documentView = resumeTable
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let add = NSButton(title: "Add Resume…", target: self, action: #selector(addResume))
        add.bezelStyle = .rounded
        add.controlSize = .large
        let makeDefault = NSButton(title: "Set as Default", target: self, action: #selector(makeResumeDefault))
        makeDefault.bezelStyle = .rounded
        let remove = NSButton(title: "Remove", target: self, action: #selector(removeResume))
        remove.bezelStyle = .rounded
        let refresh = NSButton(title: "Refresh", target: self, action: #selector(refreshResumes))
        refresh.bezelStyle = .rounded

        let buttons = NSStackView(views: [add, makeDefault, remove, NSView(), refresh])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        buttons.translatesAutoresizingMaskIntoConstraints = false

        resumeStatus.font = .systemFont(ofSize: 11)
        resumeStatus.textColor = .secondaryLabelColor
        resumeStatus.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(header)
        root.addSubview(scroll)
        root.addSubview(buttons)
        root.addSubview(resumeStatus)

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),

            scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            scroll.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -10),

            buttons.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            buttons.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            buttons.bottomAnchor.constraint(equalTo: resumeStatus.topAnchor, constant: -8),

            resumeStatus.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            resumeStatus.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            resumeStatus.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
        ])
        return root
    }

    @objc private func refreshResumes() {
        resumeStatus.stringValue = "Loading…"
        resumeStatus.textColor = .secondaryLabelColor
        ResumeService.list { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let entries):
                self.resumes = entries
                self.resumeTable.reloadData()
                self.resumeStatus.stringValue = entries.isEmpty
                    ? "No resumes yet. Click Add Resume to store one."
                    : "\(entries.count) resume(s). Roles pick from this list on the dashboard."
                self.resumeStatus.textColor = .secondaryLabelColor
            case .failure(let error):
                self.resumeStatus.stringValue = error.message
                self.resumeStatus.textColor = .systemRed
            }
        }
    }

    @objc private func addResume() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedFileTypes = ["pdf", "docx"]
        panel.prompt = "Add"
        guard panel.runModal() == .OK, let url = panel.url else { return }

        resumeStatus.stringValue = "Storing \(url.lastPathComponent) and reading its text…"
        resumeStatus.textColor = .secondaryLabelColor
        ResumeService.run(["add", url.path]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let json):
                if let error = json["extractionError"] as? String {
                    self.resumeStatus.stringValue = "Stored, but the text could not be read: \(error)"
                    self.resumeStatus.textColor = .systemOrange
                }
                self.refreshResumes()
            case .failure(let error):
                self.resumeStatus.stringValue = error.message
                self.resumeStatus.textColor = .systemRed
            }
        }
    }

    @objc private func makeResumeDefault() {
        guard let entry = selectedResume() else { return }
        ResumeService.run(["default", entry.id]) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result {
                self.resumeStatus.stringValue = error.message
                self.resumeStatus.textColor = .systemRed
            } else {
                self.refreshResumes()
            }
        }
    }

    @objc private func removeResume() {
        guard let entry = selectedResume() else { return }
        let alert = NSAlert()
        alert.messageText = "Remove “\(entry.name)”?"
        alert.informativeText = "The stored copy is deleted. Any role using it must be pointed at another resume first."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        ResumeService.run(["remove", entry.id]) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result {
                self.resumeStatus.stringValue = error.message
                self.resumeStatus.textColor = .systemRed
            } else {
                self.refreshResumes()
            }
        }
    }

    private func selectedResume() -> ResumeEntry? {
        let row = resumeTable.selectedRow
        guard row >= 0, row < resumes.count else {
            resumeStatus.stringValue = "Select a resume first."
            resumeStatus.textColor = .systemOrange
            return nil
        }
        return resumes[row]
    }

    // MARK: Settings tab

    private func buildSettingsTab() -> NSView {
        let root = NSView()
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let form = NSStackView()
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = 10
        form.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        form.translatesAutoresizingMaskIntoConstraints = false

        for field in [dashboardField, databaseField, secretField, ownerField,
                      profileField, ollamaURLField, ollamaModelField, applyRunLimitField, artifactsField,
                      ntfyTopicField] {
            field.delegate = self
            field.translatesAutoresizingMaskIntoConstraints = false
            field.widthAnchor.constraint(equalToConstant: 420).isActive = true
        }
        applyRunLimitField.widthAnchor.constraint(equalToConstant: 80).isActive = true

        // --- Connection
        form.addArrangedSubview(sectionHeader(
            "Connection",
            subtitle: "Where the agent finds your dashboard and database. Required."
        ))
        form.addArrangedSubview(formRow("Dashboard URL", dashboardField,
                                        hint: "http://localhost:3000 for local, or your Vercel URL"))
        form.addArrangedSubview(formRow("Database URL", databaseField))
        form.addArrangedSubview(formRow("Worker API secret", secretField, hint: "At least 16 characters"))

        let detect = NSButton(title: "Detect", target: self, action: #selector(detectOwnerUser))
        detect.bezelStyle = .rounded
        let ownerRow = NSStackView(views: [ownerField, detect])
        ownerRow.orientation = .horizontal
        ownerRow.spacing = 6
        form.addArrangedSubview(formRow("Owner user ID", ownerRow,
                                        hint: "Click Detect to look this up from your database."))

        form.addArrangedSubview(divider())

        // --- Tasks
        //
        // This is a permission list, not a to-do list: enabling a task only means the agent
        // will pick that work up if something queues it. All-on is the sensible default, so
        // the list stays collapsed until someone deliberately wants to narrow it.
        form.addArrangedSubview(sectionHeader(
            "Tasks",
            subtitle: "What the agent is allowed to pick up. Leaving everything on is fine — a task with no work queued simply stays idle."
        ))

        taskGrid.orientation = .vertical
        taskGrid.alignment = .leading
        taskGrid.spacing = 4
        for type in allCommandTypes {
            let box = NSButton(checkboxWithTitle: commandTypeLabels[type] ?? type,
                               target: self, action: #selector(formChanged))
            commandBoxes[type] = box
            taskGrid.addArrangedSubview(box)
        }
        taskGrid.isHidden = true

        taskDisclosure.bezelStyle = .disclosure
        taskDisclosure.setButtonType(.onOff)
        taskDisclosure.title = ""
        taskDisclosure.target = self
        taskDisclosure.action = #selector(toggleTaskList)
        taskDisclosure.state = .off

        taskSummary.font = .systemFont(ofSize: 12)

        let enableAll = NSButton(title: "Enable All", target: self, action: #selector(enableAllTasks))
        enableAll.bezelStyle = .rounded
        enableAll.controlSize = .small

        let summaryRow = NSStackView(views: [taskDisclosure, taskSummary, enableAll])
        summaryRow.orientation = .horizontal
        summaryRow.alignment = .centerY
        summaryRow.spacing = 6

        let taskColumn = NSStackView(views: [summaryRow, taskGrid])
        taskColumn.orientation = .vertical
        taskColumn.alignment = .leading
        taskColumn.spacing = 6
        form.addArrangedSubview(formRow("Enabled tasks", taskColumn))

        form.addArrangedSubview(divider())

        // --- Browser
        form.addArrangedSubview(sectionHeader(
            "Browser",
            subtitle: "The agent drives its own Chromium and never touches your personal Chrome."
        ))
        let profileRow = NSStackView(views: [profileField, browseButton(for: profileField)])
        profileRow.orientation = .horizontal
        profileRow.spacing = 6
        form.addArrangedSubview(formRow("Profile folder", profileRow,
                                        hint: "Where job site logins are stored"))
        form.addArrangedSubview(formRow(
            "Run hidden (not recommended)",
            switchRow(headlessSwitch, "Hide Chrome while working; this can trigger more verification challenges")
        ))
        form.addArrangedSubview(formRow("Browser discovery", switchRow(discoverySwitch, "Let the agent find jobs by browsing")))
        browserEnginePopup.addItems(withTitles: ["Google Chrome (recommended)", "Bundled Chromium"])
        browserEnginePopup.target = self
        browserEnginePopup.action = #selector(formChanged)
        form.addArrangedSubview(formRow("Browser engine", browserEnginePopup,
                                        hint: "Chrome passes job site bot checks that the bundled Chromium fails. Your own Chrome profile is never used."))

        form.addArrangedSubview(divider())

        // --- AI
        form.addArrangedSubview(sectionHeader(
            "AI matching",
            subtitle: "Runs locally through Ollama. Start it with: ollama serve"
        ))
        form.addArrangedSubview(formRow("Ollama URL", ollamaURLField))
        form.addArrangedSubview(formRow("Model", ollamaModelField))

        form.addArrangedSubview(divider())

        // --- Apply
        form.addArrangedSubview(sectionHeader(
            "Applying",
            subtitle: "Start in Dry run. Move to Submit for real only once you trust the results."
        ))
        form.addArrangedSubview(formRow("Enable applying", switchRow(applyEnabledSwitch, "Allow the agent to work on applications")))
        applyModePopup.addItems(withTitles: ["Dry run — look only", "Fill in, but don't submit", "Fill in and submit for real"])
        applyModePopup.target = self
        applyModePopup.action = #selector(formChanged)
        form.addArrangedSubview(formRow("Mode", applyModePopup))
        form.addArrangedSubview(formRow("Max per run", applyRunLimitField,
                                        hint: "The count resets to zero each time you start a new apply run."))
        let artifactRow = NSStackView(views: [artifactsField, browseButton(for: artifactsField)])
        artifactRow.orientation = .horizontal
        artifactRow.spacing = 6
        form.addArrangedSubview(formRow("Screenshots folder", artifactRow))

        form.addArrangedSubview(sectionHeader(
            "Phone notifications",
            subtitle: "A Mac notification stays on the Mac. Send them to your phone and watch too."
        ))
        form.addArrangedSubview(formRow("Notify my phone", switchRow(pushEnabledSwitch, "Send alerts through ntfy as well as to this Mac")))
        form.addArrangedSubview(formRow("ntfy topic", ntfyTopicField,
                                        hint: "Subscribe to this same topic in the ntfy app. Anyone who knows it can read your alerts, so make it long and unguessable."))

        scroll.documentView = form

        let save = NSButton(title: "Save Settings", target: self, action: #selector(saveTapped))
        save.bezelStyle = .rounded
        save.controlSize = .large
        saveStatus.font = .systemFont(ofSize: 11)
        saveStatus.textColor = .secondaryLabelColor

        let bar = NSStackView(views: [saveStatus, NSView(), save])
        bar.orientation = .horizontal
        bar.spacing = 10
        bar.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(scroll)
        root.addSubview(bar)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: root.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -10),

            bar.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            bar.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            bar.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),

            form.widthAnchor.constraint(equalTo: scroll.widthAnchor),
        ])
        return root
    }

    private func divider() -> NSView {
        let line = NSBox()
        line.boxType = .separator
        line.translatesAutoresizingMaskIntoConstraints = false
        line.widthAnchor.constraint(equalToConstant: 600).isActive = true
        return line
    }

    private func switchRow(_ toggle: NSSwitch, _ text: String) -> NSView {
        toggle.target = self
        toggle.action = #selector(formChanged)
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor
        let row = NSStackView(views: [toggle, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        return row
    }

    private func browseButton(for field: NSTextField) -> NSButton {
        let button = NSButton(title: "Choose…", target: self, action: #selector(chooseFolder(_:)))
        button.bezelStyle = .rounded
        button.identifier = NSUserInterfaceItemIdentifier(field === profileField ? "profile" : "artifacts")
        return button
    }

    // MARK: Form <-> config

    private func loadIntoForm() {
        config.reload()
        dashboardField.stringValue = config.get(Key.dashboardURL)
        databaseField.stringValue = config.get(Key.databaseURL)
        secretField.stringValue = config.get(Key.apiSecret)
        ownerField.stringValue = config.get(Key.ownerUserID)
        profileField.stringValue = config.get(Key.browserProfile)
        ollamaURLField.stringValue = config.get(Key.ollamaURL)
        ollamaModelField.stringValue = config.get(Key.ollamaModel)
        applyRunLimitField.stringValue = config.get(Key.applyMaxPerRun)
        artifactsField.stringValue = config.get(Key.applyArtifacts)
        ntfyTopicField.stringValue = config.get(Key.ntfyTopic)

        headlessSwitch.state = config.bool(Key.browserHeadless) ? .on : .off
        discoverySwitch.state = config.bool(Key.browserDiscovery) ? .on : .off
        applyEnabledSwitch.state = config.bool(Key.applyEnabled) ? .on : .off
        pushEnabledSwitch.state = config.bool(Key.pushEnabled) ? .on : .off
        browserEnginePopup.selectItem(at: config.get(Key.browserChannel) == "bundled" ? 1 : 0)

        switch config.get(Key.applyMode) {
        case "fill_only": applyModePopup.selectItem(at: 1)
        case "fill_and_submit": applyModePopup.selectItem(at: 2)
        default: applyModePopup.selectItem(at: 0)
        }

        let enabled = Set(config.selectedCommands())
        for (type, box) in commandBoxes { box.state = enabled.contains(type) ? .on : .off }

        // Secrets already in .env.local do not need retyping; show that rather than a blank box.
        databaseField.placeholderString = config.isInherited(Key.databaseURL)
            ? "Using the value from .env.local" : "postgresql://…"
        secretField.placeholderString = config.isInherited(Key.apiSecret)
            ? "Using the value from .env.local" : "long random string"

        updateFormIntoConfig()
    }

    private func updateFormIntoConfig() {
        config.set(Key.dashboardURL, dashboardField.stringValue)
        config.set(Key.databaseURL, databaseField.stringValue)
        config.set(Key.apiSecret, secretField.stringValue)
        config.set(Key.ownerUserID, ownerField.stringValue)
        config.set(Key.browserProfile, profileField.stringValue)
        config.set(Key.ollamaURL, ollamaURLField.stringValue)
        config.set(Key.ollamaModel, ollamaModelField.stringValue)
        config.set(Key.applyMaxPerRun, applyRunLimitField.stringValue)
        config.set(Key.applyArtifacts, artifactsField.stringValue)
        config.set(Key.ntfyTopic, ntfyTopicField.stringValue)

        config.set(Key.browserHeadless, headlessSwitch.state == .on ? "true" : "false")
        config.set(Key.browserDiscovery, discoverySwitch.state == .on ? "true" : "false")
        config.set(Key.applyEnabled, applyEnabledSwitch.state == .on ? "true" : "false")
        config.set(Key.pushEnabled, pushEnabledSwitch.state == .on ? "true" : "false")
        config.set(Key.browserChannel, browserEnginePopup.indexOfSelectedItem == 0 ? "chrome" : "bundled")

        switch applyModePopup.indexOfSelectedItem {
        case 1: config.set(Key.applyMode, "fill_only")
        case 2: config.set(Key.applyMode, "fill_and_submit")
        default: config.set(Key.applyMode, "dry_run")
        }

        let enabled = allCommandTypes.filter { commandBoxes[$0]?.state == .on }
        config.setCommands(enabled)

        // Keep the count meaningful while the list is collapsed.
        taskSummary.stringValue = enabled.count == allCommandTypes.count
            ? "All \(allCommandTypes.count) tasks enabled"
            : "\(enabled.count) of \(allCommandTypes.count) tasks enabled"
        taskSummary.textColor = enabled.isEmpty ? .systemRed : .secondaryLabelColor

        refreshReadiness()
    }

    func controlTextDidChange(_ obj: Notification) { updateFormIntoConfig() }

    @objc private func formChanged() { updateFormIntoConfig() }

    @objc private func toggleTaskList() {
        taskGrid.isHidden = taskDisclosure.state != .on
    }

    @objc private func enableAllTasks() {
        for box in commandBoxes.values { box.state = .on }
        updateFormIntoConfig()
    }

    /// Fills in the owner user ID from the database so nobody has to hunt for a UUID.
    @objc private func detectOwnerUser() {
        saveStatus.stringValue = "Looking up users…"
        saveStatus.textColor = .secondaryLabelColor

        UserService.list { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.saveStatus.stringValue = error.message
                self.saveStatus.textColor = .systemRed

            case .success(let users):
                guard !users.isEmpty else {
                    self.saveStatus.stringValue = "No users found. Sign in to the dashboard once first."
                    self.saveStatus.textColor = .systemOrange
                    return
                }

                // Seed and crash-test rows would only clutter the choice.
                let real = users.filter { !$0.isLikelyTestAccount }
                let candidates = real.isEmpty ? users : real

                if candidates.count == 1 {
                    self.ownerField.stringValue = candidates[0].id
                    self.updateFormIntoConfig()
                    self.saveStatus.stringValue = "Found \(candidates[0].display). Click Save Settings to keep it."
                    self.saveStatus.textColor = .secondaryLabelColor
                    return
                }
                self.pickOwnerUser(from: candidates)
            }
        }
    }

    private func pickOwnerUser(from users: [DashboardUser]) {
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 320, height: 25))
        for user in users { popup.addItem(withTitle: user.display) }

        let alert = NSAlert()
        alert.messageText = "Which account is yours?"
        alert.informativeText = "The agent applies to jobs on behalf of this account."
        alert.accessoryView = popup
        alert.addButton(withTitle: "Use This Account")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let chosen = users[popup.indexOfSelectedItem]
        ownerField.stringValue = chosen.id
        updateFormIntoConfig()
        saveStatus.stringValue = "Using \(chosen.display). Click Save Settings to keep it."
        saveStatus.textColor = .secondaryLabelColor
    }

    @objc private func chooseFolder(_ sender: NSButton) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Choose"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if sender.identifier?.rawValue == "profile" {
            profileField.stringValue = url.path
        } else {
            artifactsField.stringValue = url.path
        }
        updateFormIntoConfig()
    }

    @objc private func saveTapped() {
        updateFormIntoConfig()
        do {
            try config.save()
            saveStatus.stringValue = "Saved. \(worker.state == .stopped ? "" : "Restart the agent to apply.")"
            saveStatus.textColor = .secondaryLabelColor
        } catch {
            saveStatus.stringValue = "Could not save: \(error.localizedDescription)"
            saveStatus.textColor = .systemRed
        }
    }

    // MARK: Readiness + state

    private func refreshReadiness() {
        checklistStack.subviews.forEach { $0.removeFromSuperview() }
        let issues = config.blockingIssues()
        let warnings = config.warnings()

        if issues.isEmpty {
            checklistStack.addArrangedSubview(checkRow("Settings look good", ok: true))
        } else {
            for issue in issues { checklistStack.addArrangedSubview(checkRow(issue, ok: false)) }
        }
        for warning in warnings { checklistStack.addArrangedSubview(checkRow(warning, ok: nil)) }

        startButton.isEnabled = issues.isEmpty && worker.state == .stopped
    }

    /// ok = true (green check), false (red x), nil (yellow warning).
    private func checkRow(_ text: String, ok: Bool?) -> NSView {
        let symbol: String
        let color: NSColor
        switch ok {
        case .some(true): symbol = "checkmark.circle.fill"; color = .systemGreen
        case .some(false): symbol = "xmark.circle.fill"; color = .systemRed
        case .none: symbol = "exclamationmark.triangle.fill"; color = .systemOrange
        }
        let icon = NSImageView()
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        icon.contentTintColor = color
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 11)
        let row = NSStackView(views: [icon, label])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        return row
    }

    private func render(_ state: WorkerState) {
        switch state {
        case .stopped:
            statusDot.textColor = .systemGray
            statusTitle.stringValue = "Stopped"
            statusDetail.stringValue = "The agent is not looking for work."
            stopButton.isEnabled = false
            stopButton.title = "Stop Agent"
            stopLogTimer()
        case .running:
            statusDot.textColor = .systemGreen
            statusTitle.stringValue = "Running"
            statusDetail.stringValue = "Listening for requests from the dashboard."
            stopButton.isEnabled = true
            stopButton.title = "Stop Agent"
            startLogTimer()
        case .stopping:
            statusDot.textColor = .systemOrange
            statusTitle.stringValue = "Stopping"
            statusDetail.stringValue = "Finishing the current job. Click again to stop immediately."
            stopButton.isEnabled = true
            stopButton.title = "Force Stop"
        }
        refreshReadiness()
        NotificationCenter.default.post(name: .workerStateChanged, object: state)
    }

    private func startLogTimer() {
        guard logTimer == nil else { return }
        refreshLog()
        logTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.refreshLog()
        }
    }

    private func stopLogTimer() {
        logTimer?.invalidate()
        logTimer = nil
        refreshLog()
    }

    private func refreshLog() {
        let text = worker.recentLog()
        guard text != logView.string else { return }
        logView.string = text
        logView.scrollToEndOfDocument(nil)
    }

    // MARK: Actions

    /// Queues one default apply cycle. Board selection and the per-run limit live on the
    /// dashboard; this is the shortcut for starting a run without opening a browser. The
    /// agent must be running to pick it up, but the cycle is queued either way.
    @objc private func runCycleNow() {
        runCycleButton.isEnabled = false
        statusDetail.stringValue = "Queueing a cycle…"
        ScriptRunner.run("worker/scripts/enqueueApplyCycle.ts", []) { [weak self] result in
            guard let self else { return }
            self.runCycleButton.isEnabled = true
            switch result {
            case .success(let json):
                let boards = (json["sources"] as? [String])?.joined(separator: " and ") ?? "all boards"
                self.statusDetail.stringValue = self.worker.state == .running
                    ? "Cycle queued for \(boards). Watch the activity log below."
                    : "Cycle queued for \(boards). Start the agent to run it."
            case .failure(let error):
                self.statusDetail.stringValue = error.message
            }
        }
    }

    @objc private func startTapped() { worker.start() }
    @objc private func stopTapped() { worker.stop() }

    @objc private func openLogFile() { NSWorkspace.shared.open(worker.logURL) }

    @objc private func openDashboard() {
        let base = config.get(Key.dashboardURL).isEmpty ? "http://localhost:3000" : config.get(Key.dashboardURL)
        if let url = URL(string: base) { NSWorkspace.shared.open(url) }
    }

    /// Opens the agent's Chromium profile so job site logins can be done by hand.
    ///
    /// This deliberately does not drive Terminal via AppleScript: that needs the user to
    /// grant Automation permission and fails with error -1743 until they do. Running the
    /// script as a direct child process needs no permissions at all.
    @objc private func openLogin() {
        guard worker.state == .stopped else {
            worker.notify(
                title: "Stop the agent first",
                body: "Chromium locks its profile folder, so the agent must be stopped before you can log in."
            )
            return
        }
        guard loginProcess == nil else {
            worker.notify(title: "Already open", body: "A login window is already running.")
            return
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: nodeBin)
        task.arguments = ["\(repoDir)/node_modules/.bin/tsx", "worker/scripts/browserLogin.ts"]
        task.currentDirectoryURL = URL(fileURLWithPath: repoDir)

        var env = ProcessInfo.processInfo.environment
        for (key, value) in config.values { env[key] = value }
        env["PATH"] = "\(URL(fileURLWithPath: nodeBin).deletingLastPathComponent().path):/usr/local/bin:/usr/bin:/bin"
        task.environment = env

        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe

        do {
            try task.run()
        } catch {
            worker.notify(title: "Could not start the login browser", body: error.localizedDescription)
            return
        }
        loginProcess = task

        // The script keeps the browser open until it is signalled, so the alert is what
        // tells it the user is finished.
        let alert = NSAlert()
        alert.messageText = "Log in to your job sites"
        alert.informativeText = """
            A Chromium window is opening with Indeed, Dice and LinkedIn.

            Sign in to each one, and solve any CAPTCHA or two-factor prompt now so the agent \
            does not hit it later.

            Click Done when you have finished — your logins are saved for the agent to reuse.
            """
        alert.addButton(withTitle: "Done")
        alert.runModal()

        if task.isRunning {
            // SIGTERM lets the script close the browser context and flush the profile.
            kill(task.processIdentifier, SIGTERM)
        }
        task.waitUntilExit()
        loginProcess = nil

        resumeStatus.stringValue = "Job site logins saved."
        resumeStatus.textColor = .secondaryLabelColor
    }

    func present() {
        loadIntoForm()
        refreshResumes()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

// MARK: - Resume table

extension MainWindowController {
    func numberOfRows(in tableView: NSTableView) -> Int { resumes.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < resumes.count else { return nil }
        let entry = resumes[row]

        let title = NSTextField(labelWithString: entry.isDefault ? "\(entry.name)  ·  Default" : entry.name)
        title.font = .systemFont(ofSize: 13, weight: entry.isDefault ? .semibold : .regular)

        let detail = NSTextField(labelWithString: entry.status)
        detail.font = .systemFont(ofSize: 11)
        detail.textColor = entry.isHealthy ? .secondaryLabelColor : .systemOrange

        let text = NSStackView(views: [title, detail])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 1

        let icon = NSImageView()
        icon.image = NSImage(
            systemSymbolName: entry.isHealthy ? "doc.text.fill" : "exclamationmark.triangle.fill",
            accessibilityDescription: nil
        )
        icon.contentTintColor = entry.isHealthy ? .systemGreen : .systemOrange

        let row = NSStackView(views: [icon, text])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 10
        row.edgeInsets = NSEdgeInsets(top: 4, left: 6, bottom: 4, right: 6)
        return row
    }
}

extension Notification.Name {
    static let workerStateChanged = Notification.Name("JobAgentWorkerStateChanged")
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var main: MainWindowController?
    private let worker = WorkerController.shared
    private let statusMenuItem = NSMenuItem(title: "Stopped", action: nil, keyEquivalent: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        let menu = NSMenu()
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())

        let openItem = NSMenuItem(title: "Open JobAgent", action: #selector(openMain), keyEquivalent: "o")
        openItem.target = self
        menu.addItem(openItem)
        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu

        // Asked once, up front, so the first real notification is not silently dropped.
        Notifier.requestPermission()

        NotificationCenter.default.addObserver(
            self, selector: #selector(stateChanged(_:)), name: .workerStateChanged, object: nil
        )
        renderStatusItem(.stopped)

        // The window is the whole point of the app, so show it on launch.
        openMain()
        if ProcessInfo.processInfo.arguments.contains("--start") {
            worker.start()
        }
    }

    /// Closing the window must not stop the agent; the menu bar item stays in charge.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        worker.shutdownForAppExit()
    }

    /// Clicking the Dock icon after closing the window brings it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { openMain() }
        return true
    }

    @objc private func stateChanged(_ note: Notification) {
        renderStatusItem(note.object as? WorkerState ?? .stopped)
    }

    private func renderStatusItem(_ state: WorkerState) {
        let symbol: String
        switch state {
        case .stopped: symbol = "moon.zzz"; statusMenuItem.title = "Stopped"
        case .running: symbol = "bolt.fill"; statusMenuItem.title = "Running"
        case .stopping: symbol = "hourglass"; statusMenuItem.title = "Stopping…"
        }
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: statusMenuItem.title)
            button.image?.isTemplate = true
        }
    }

    @objc private func openMain() {
        if main == nil { main = MainWindowController() }
        main?.present()
    }

    @objc private func quit() {
        if worker.state != .stopped {
            let alert = NSAlert()
            alert.messageText = "The agent is still running"
            alert.informativeText = "Stop it before quitting so the current job is not interrupted."
            alert.addButton(withTitle: "Stop and Quit")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() != .alertFirstButtonReturn { return }
            worker.stop()
        }
        NSApp.terminate(nil)
    }
}

/// Without an explicit menu bar, an app built this way has no Edit menu, and the standard
/// Cut/Copy/Paste key equivalents do not reach text fields — which matters a great deal on
/// a settings screen people paste into.
func buildMainMenu() -> NSMenu {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About JobAgent", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide JobAgent", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit JobAgent", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appMenuItem.submenu = appMenu
    mainMenu.addItem(appMenuItem)

    let editMenuItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editMenuItem.submenu = editMenu
    mainMenu.addItem(editMenuItem)

    let windowMenuItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowMenuItem.submenu = windowMenu
    mainMenu.addItem(windowMenuItem)

    return mainMenu
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.mainMenu = buildMainMenu()
// .regular puts JobAgent in the Dock and the app switcher. The menu bar item stays too, so
// the agent can still be started and stopped without bringing the window forward.
app.setActivationPolicy(.regular)
app.run()
