import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

// State and process plumbing for the Hetzner Cloud panel.
//
// Every API call goes through bin/omarchy-hcloud-bridge, which reads the
// project token out of the login keyring itself. No token ever reaches a
// Process command line — `/proc/<pid>/cmdline` is world-readable — so the
// only secret this QML object ever touches is the one the user just typed,
// on its way to the bridge over stdin.
Item {
  id: root

  property var settings: ({})

  // Self-locating so the plugin works from ~/.config/omarchy/plugins, from a
  // clone symlinked into place, or from anywhere else it gets installed.
  readonly property string bridgePath: decodeURIComponent(String(Qt.resolvedUrl("bin/omarchy-hcloud-bridge")).replace(/^file:\/\//, ""))

  // One entry per label: { label, keys }. See Model.normalizeAccounts for the
  // legacy shapes this still reads.
  // Demo data: an invented fleet from demo/fleet.json, for screenshots. The
  // bridge answers from the file and refuses the keyring; the panel shows the
  // demo labels in place of the real ones. The ssh sync, if on, writes the
  // demo hosts like any others — the real block is backed up and comes back
  // with the next real sync.
  readonly property bool demo: boolSetting("demo", false)
  readonly property var accounts: demo ? Model.demoAccounts() : Model.normalizeAccounts(settings)
  readonly property var labels: Model.accountLabels(accounts)
  // The bridge is asked per keyring key; a label may own several.
  readonly property var keys: Model.accountKeys(accounts)
  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 300, 15, 3600)

  // Set by the panel. Polling a remote API once a minute all day for an icon
  // nobody is looking at is the one cost this widget can actually avoid.
  property bool panelOpen: false
  readonly property int idleIntervalSec: intSetting("idleIntervalSec", 600, 60, 86400)
  readonly property int effectiveIntervalSec: {
    if (panelOpen) return refreshIntervalSec
    // The ssh sync runs off the refresh cycle, so it has to keep its cadence
    // whether or not the panel is on screen.
    if (syncSshConfig) return refreshIntervalSec
    // Never idle *faster* than the user asked to refresh.
    return Math.max(refreshIntervalSec, idleIntervalSec)
  }

  // The shell builds one instance of the widget per monitor, and each has a
  // Service of its own. Polling a remote API once per screen multiplies the
  // request count by the monitor count, so the panel names one instance
  // primary — see Panel.isPrimary — and only that one fetches while the panel
  // is closed. Its result is handed to the others; a panel that is open
  // fetches for itself whichever screen it sits on.
  property var primaryCheck: null   // () -> bool
  property var primaryOutput: null  // () -> string, the primary's last bridge output
  property string lastServersRaw: ""
  signal serversLoaded(string raw)

  function isPrimary() {
    return typeof primaryCheck === "function" ? primaryCheck() === true : true
  }

  // The bridge fetches the projects side by side, three requests each, every
  // request capped at 15 s and retried once on a timeout. A minute covers a
  // slow answer or two; past that the network is gone and the panel would
  // rather say so than keep a spinner.
  readonly property int watchdogMs: 60000
  // When the list on screen was fetched. Stays put through a failed refresh,
  // which is exactly when someone wants to know how old the data is.
  property string lastUpdated: ""
  property real lastFetchMs: 0

  // Opening the panel used to fetch every time. With a poll already running
  // in the background that is a request for nothing, so the open only fetches
  // when what is on screen is older than the interval, or is not there at all.
  function refreshIfStale() {
    if (!loaded || lastError !== "") { refresh(); return }
    if (Date.now() - lastFetchMs >= refreshIntervalSec * 1000) refresh()
  }
  property bool _timedOut: false

  readonly property bool syncSshConfig: boolSetting("syncSshConfig", false)
  readonly property string sshUser: String(setting("sshUser", "root"))
  // Empty by default: ssh tries the usual keys and the agent on its own, and a
  // named key is only right for the one person whose key has that name.
  readonly property string sshKey: String(setting("sshKey", ""))

  property var projects: []
  property bool loaded: false
  property bool refreshing: false
  property string lastError: ""
  property string actionStatus: ""
  property string pendingLabel: ""
  property string pendingKey: ""

  // Last ssh sync outcome, for the panel to show. `at` empty means never run
  // in this session.
  // Storage boxes ride along with the per-project fetch: Hetzner's newer API
  // serves them to the same token, so there is no second credential and no
  // second refresh cycle.
  readonly property var boxes: Model.collectStorageBoxes(projects)
  readonly property string boxesError: Model.storageBoxError(projects)

  // Metrics are fetched for the row that is open and nothing else, so the
  // request count does not grow with the size of the fleet.
  // The window the curve covers. Same request count whichever is chosen.
  property int metricsWindow: 3600
  property var metricsSeries: []
  property string metricsServerId: ""
  property string metricsLabel: ""
  property var metrics: ({})
  property string metricsError: ""

  property var syncResult: ({ at: "", hosts: 0, error: "", changed: false })
  readonly property string syncStatusText: Model.syncStatusText(syncSshConfig, syncResult)

  readonly property bool busy: serversProcess.running || storeProcess.running || removeProcess.running

  signal tokenStored(string label, string key)
  signal tokenRemoved(string label)

  property string _serversOutput: ""
  property string _serversError: ""

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // `omarchy bar set` writes a string unless told --json, so "true" has to
  // count as much as true. Anything else is off.
  function boolSetting(name, fallback) {
    var value = setting(name, fallback)
    return value === true || String(value).toLowerCase() === "true"
  }

  function intSetting(name, fallback, min, max) {
    var n = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(n)) n = fallback
    if (n < min) n = min
    if (n > max) n = max
    return n
  }

  // Flipping the switch swaps the whole world, so whatever is on screen is
  // wrong the moment it flips. Drop it and fetch again now rather than letting
  // the old list sit there until the next poll comes round.
  onDemoChanged: {
    projects = []
    loaded = false
    lastError = ""
    lastServersRaw = ""
    lastUpdated = ""
    lastFetchMs = 0
    clearMetrics()
    delayedRefresh.restart()
  }

  function bridgeArgs(command) {
    var args = ["python3", bridgePath]
    if (demo) args.push("--demo")
    args.push(command)
    return args
  }

  function copyToClipboard(value) {
    var text = String(value || "")
    if (text === "") return
    Quickshell.execDetached(["bash", "-c", "printf %s " + Util.shellQuote(text) + " | wl-copy"])
    flash("Copied " + (text.length > 40 ? text.substring(0, 37) + "…" : text))
  }

  function flash(message) {
    actionStatus = String(message || "")
    actionStatusTimer.restart()
  }

  function elide(text) {
    var value = String(text || "").replace(/\s+/g, " ").trim()
    return value.length > 160 ? value.substring(0, 157) + "…" : value
  }

  // A refresh someone asked for by hand says so when it lands, since a fleet
  // that has not changed would otherwise look as if nothing happened.
  property bool _announce: false

  function refreshManually() {
    if (serversProcess.running) { flash("Refreshing…"); return }
    _announce = true
    refresh()
  }

  function refresh() {
    if (serversProcess.running) return
    if (keys.length === 0) {
      projects = []
      lastError = ""
      loaded = true
      return
    }
    if (!panelOpen && !isPrimary()) {
      // Idle polling is the primary's job. An instance that arrived after its
      // last poll — a monitor plugged in — takes what it already has rather
      // than sitting dark until the next cycle.
      if (!loaded && typeof primaryOutput === "function") applyShared(primaryOutput())
      return
    }
    _serversOutput = ""
    _serversError = ""
    _timedOut = false
    refreshing = true
    serversProcess.command = bridgeArgs("servers").concat(keys)
    serversProcess.running = true
    // Armed per launch and disarmed on exit, so it only ever measures the
    // process that is actually running. Left running across launches it fired
    // at a fresh process a few seconds in whenever two refreshes fell inside
    // one budget — a token saved, or `r` pressed twice.
    pollWatchdog.restart()
    if (metricsServerId !== "") requestMetrics(metricsLabel, metricsServerId)
  }

  function requestMetrics(label, serverId) {
    metricsLabel = String(label || "")
    metricsServerId = String(serverId || "")
    if (metricsServerId === "" || metricsLabel === "") {
      metrics = ({})
      metricsError = ""
      return
    }
    if (metricsProcess.running) return
    metricsProcess.command = bridgeArgs("metrics").concat([metricsLabel, metricsServerId, String(metricsWindow)])
    metricsProcess.running = true
    if (metricsTimer.running) metricsTimer.restart()
  }

  function clearMetrics() {
    metricsServerId = ""
    metricsLabel = ""
    metrics = ({})
    metricsSeries = []
    metricsError = ""
  }

  function setMetricsWindow(seconds) {
    if (metricsWindow === seconds) return
    metricsWindow = seconds
    metricsSeries = []
    if (metricsServerId !== "") requestMetrics(metricsLabel, metricsServerId)
  }

  function applyServers(raw) {
    var parsed = Model.parseBridge(raw, accounts)
    if (!parsed.ok) {
      _announce = false
      lastError = parsed.error
      loaded = true
      return
    }
    projects = Model.retainPrevious(parsed.projects, projects)
    lastError = ""
    loaded = true
    lastServersRaw = String(raw || "")
    lastUpdated = Qt.formatDateTime(new Date(), "HH:mm:ss")
    lastFetchMs = Date.now()
    if (_announce) {
      _announce = false
      var count = 0
      for (var i = 0; i < projects.length; i++) count += (projects[i].servers || []).length
      flash("Refreshed · " + Model.plural(count, "server"))
    }
    // Writing the ssh config is one instance's job, not one per screen.
    if (isPrimary()) maybeSyncSsh()
    serversLoaded(lastServersRaw)
  }

  // A result another instance fetched. Same parse, but no ssh sync and no
  // onward push — the instance that fetched it does both.
  function applyShared(raw) {
    var text = String(raw || "")
    if (text === "") return
    var parsed = Model.parseBridge(text, accounts)
    if (!parsed.ok) return
    projects = Model.retainPrevious(parsed.projects, projects)
    lastError = ""
    loaded = true
    lastServersRaw = text
    lastUpdated = Qt.formatDateTime(new Date(), "HH:mm:ss")
    lastFetchMs = Date.now()
  }

  // Runs off the back of a successful refresh rather than on its own timer, so
  // the file can never describe a fleet the panel is not also showing.
  function maybeSyncSsh() {
    if (!syncSshConfig || syncProcess.running) return
    if (!Model.canSyncSsh(projects)) {
      syncResult = { at: syncResult.at, hosts: syncResult.hosts, changed: false,
        error: "Not syncing while a project is unreadable" }
      return
    }
    var job = {
      user: sshUser,
      key: sshKey,
      hosts: Model.sshHosts(projects)
    }
    syncProcess.job = JSON.stringify(job)
    syncProcess.command = bridgeArgs("sync-ssh")
    syncProcess.running = true
  }

  function applySyncResult(raw) {
    var text = String(raw || "").trim()
    var now = Qt.formatDateTime(new Date(), "HH:mm")
    try {
      var data = JSON.parse(text)
      if (data && data.ok === true) {
        syncResult = { at: now, hosts: Number(data.hosts) || 0, changed: data.changed === true, error: "" }
        return
      }
      syncResult = { at: now, hosts: 0, changed: false, error: elide(String(data && data.error) || "SSH config sync failed") }
    } catch (e) {
      syncResult = { at: now, hosts: 0, changed: false, error: "Could not read the sync result" }
    }
  }

  // The token goes to the bridge over stdin, never argv. The label is not a
  // secret and rides along on the command line.
  function addToken(label, token) {
    var name = String(label || "").trim()
    var secret = String(token || "")
    if (storeProcess.running) return false
    if (demo) { flash("Demo data is on — turn it off to add a token"); return false }
    if (name === "") { flash("Give the project a label"); return false }
    // The label travels to secret-tool as a positional argument.
    if (name.charAt(0) === "-") { flash("A label cannot start with a dash"); return false }
    if (secret === "") { flash("Paste a Hetzner API token"); return false }
    var key = Model.nextKey(accounts, name)
    if (key === "") { flash("Could not find a free slot for that label"); return false }
    pendingLabel = name
    pendingKey = key
    storeProcess.secret = secret
    storeProcess.command = bridgeArgs("store").concat([key])
    storeProcess.running = true
    return true
  }

  // A label may own several tokens, and every one of them has to leave the
  // keyring — otherwise a re-added label would silently inherit them.
  property var pendingRemovals: []

  function removeToken(label) {
    var name = String(label || "").trim()
    if (name === "" || removeProcess.running) return
    if (demo) { flash("Demo data is on — turn it off to remove a token"); return }
    var account = null
    for (var i = 0; i < accounts.length; i++) if (accounts[i].label === name) account = accounts[i]
    if (!account) return
    pendingLabel = name
    pendingRemovals = account.keys.slice()
    removeNextKey()
  }

  function removeNextKey() {
    if (pendingRemovals.length === 0) {
      flash("Removed " + pendingLabel)
      tokenRemoved(pendingLabel)
      pendingLabel = ""
      delayedRefresh.restart()
      return
    }
    var next = pendingRemovals[0]
    pendingRemovals = pendingRemovals.slice(1)
    removeProcess.command = bridgeArgs("remove").concat([next])
    removeProcess.running = true
  }

  function bridgeMessage(raw, fallback) {
    try {
      var data = JSON.parse(String(raw || "").trim())
      if (data && data.error) return String(data.error)
    } catch (e) {
      // Not JSON — the caller's fallback is the better message.
    }
    return fallback
  }

  Timer {
    id: refreshTimer
    interval: root.effectiveIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    // The curve is only as fresh as its last request, and the refresh interval
    // may well be set to minutes. Hetzner's finest step is one minute, so the
    // open row is asked again every minute, counted from whoever asked last.
    id: metricsTimer
    interval: 60000
    repeat: true
    running: root.panelOpen && root.metricsServerId !== ""
    onTriggered: root.requestMetrics(root.metricsLabel, root.metricsServerId)
  }

  Timer {
    id: delayedRefresh
    interval: 400
    repeat: false
    onTriggered: root.refresh()
  }

  Timer {
    // A refresh is skipped while its own process is still running, so a bridge
    // call that never returns — a network that is coming and going will do it —
    // would silently stop the panel updating for good. Reap it, and say so.
    id: pollWatchdog
    interval: root.watchdogMs
    repeat: false
    onTriggered: {
      if (!serversProcess.running) return
      root._timedOut = true
      serversProcess.running = false
    }
  }

  Timer {
    id: actionStatusTimer
    interval: 2600
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Process {
    id: serversProcess
    running: false
    command: []
    stdout: StdioCollector { id: serversStdout; waitForEnd: true; onStreamFinished: root._serversOutput = text }
    stderr: StdioCollector { id: serversStderr; waitForEnd: true; onStreamFinished: root._serversError = text }
    onExited: function(exitCode) {
      pollWatchdog.stop()
      root.refreshing = false
      var stdout = String(serversStdout.text || root._serversOutput || "")
      var stderr = String(serversStderr.text || root._serversError || "")
      if (exitCode === 0) root.applyServers(stdout)
      else {
        root._announce = false
        root.loaded = true
        root.lastError = root._timedOut
          ? "The Hetzner bridge did not answer within " + Math.round(root.watchdogMs / 1000) + " s"
          : root.elide(root.bridgeMessage(stdout, stderr || "The Hetzner bridge failed to run"))
      }
    }
  }

  Process {
    id: storeProcess
    property string secret: ""
    running: false
    command: []
    stdinEnabled: true
    onStarted: {
      write(secret + "\n")
      secret = ""
    }
    stdout: StdioCollector { id: storeStdout; waitForEnd: true }
    stderr: StdioCollector { id: storeStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var label = root.pendingLabel
      root.pendingLabel = ""
      if (exitCode === 0) {
        root.flash("Saved token for " + label)
        root.tokenStored(label, root.pendingKey)
        root.pendingKey = ""
        delayedRefresh.restart()
      } else {
        root.lastError = root.elide(root.bridgeMessage(String(storeStdout.text || ""),
          String(storeStderr.text || "") || "Could not save the token to the keyring"))
        root.flash(root.lastError)
      }
    }
  }

  Process {
    id: metricsProcess
    running: false
    command: []
    stdout: StdioCollector { id: metricsStdout; waitForEnd: true }
    onExited: function(exitCode) {
      var parsed = Model.parseMetrics(exitCode === 0 ? String(metricsStdout.text || "") : "")
      root.metrics = parsed.ok ? parsed.metrics : ({})
      root.metricsSeries = parsed.ok ? (parsed.series || []) : []
      // A type that failed on its own is a note, not a failure — the others
      // still have something to say.
      root.metricsError = root.elide(parsed.ok ? String(parsed.partial || "") : parsed.error)
    }
  }

  Process {
    id: syncProcess
    property string job: ""
    running: false
    command: []
    stdinEnabled: true
    onStarted: {
      write(job + "\n")
      job = ""
    }
    stdout: StdioCollector { id: syncStdout; waitForEnd: true }
    stderr: StdioCollector { id: syncStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) root.applySyncResult(String(syncStdout.text || ""))
      else root.applySyncResult(JSON.stringify({
        ok: false,
        error: String(syncStderr.text || "") || "The SSH config sync failed to run"
      }))
    }
  }

  Process {
    id: removeProcess
    running: false
    command: []
    stdout: StdioCollector { id: removeStdout; waitForEnd: true }
    stderr: StdioCollector { id: removeStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.pendingRemovals = []
        root.pendingLabel = ""
        root.lastError = root.elide(root.bridgeMessage(String(removeStdout.text || ""),
          String(removeStderr.text || "") || "Could not remove the token from the keyring"))
        root.flash(root.lastError)
        return
      }
      root.removeNextKey()
    }
  }
}
