import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronUp,
  Circle,
  Coffee,
  Compass,
  Heart,
  type LucideIcon,
  Package,
  Play,
  PlayCircle,
  RefreshCw,
  Send,
  Settings2,
  Signal,
  Square,
  Terminal,
  Users,
} from "lucide-react";
import { useNavigate } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/convex/_generated/api";
import { runCommand } from "@/bot/core/commands";
import { useAuth } from "@/hooks/use-auth";
import {
  applySettings,
  botHasPassword,
  getBot,
  getLogger,
  type DashboardSettings,
  type LogEntry,
} from "@/lib/botClient";

const CONNECTED_STATES = ["connecting", "idle", "pathing", "following", "combat"];

const ACTIVITY_COLORS: Record<string, string> = {
  disconnected: "text-muted-foreground",
  connecting: "text-chart-2",
  idle: "text-primary",
  pathing: "text-chart-2",
  following: "text-chart-2",
  combat: "text-destructive",
  dead: "text-destructive",
};

const LEVEL_COLORS: Record<string, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-chart-2",
  error: "text-destructive",
};

const POLICIES = [
  { value: "accept", label: "Accept all packs" },
  { value: "decline", label: "Decline all packs" },
  { value: "required-only", label: "Accept required only" },
  { value: "download-and-accept", label: "Download then accept" },
] as const;

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass = {
    default: "text-foreground",
    good: "text-primary",
    warn: "text-chart-2",
    bad: "text-destructive",
  }[tone];
  return (
    <Card className="border-border/70 shadow-none">
      <CardContent className="flex items-start gap-3 pt-5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="size-4 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className={`truncate text-lg font-bold tracking-tight ${toneClass}`}>{value}</p>
          {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function Bar({ value, max, tone }: { value: number; max: number; tone: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full transition-all ${tone}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function useBotSnapshot() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => ({ tick, snapshot: getBot().snapshot() }), [tick]);
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const settingsRaw = useQuery(api.bot.getSettings);
  const ensureSettings = useMutation(api.bot.ensureSettings);
  const saveSettings = useMutation(api.bot.saveSettings);
  const clearEvents = useMutation(api.bot.clearEvents);

  const bot = getBot();
  const { snapshot } = useBotSnapshot();
  const recordEvent = useMutation(api.bot.recordEvent);
  const recordedRef = useRef<string>("");
  const [history, setHistory] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showSettings, setShowSettings] = useState(false);

  // Settings form state
  const [form, setForm] = useState<DashboardSettings>({
    username: "PancakeBot",
    hasPassword: false,
    loginCommand: "/login {password}",
    registerCommand: "/register {password} {password2}",
    resourcePackPolicy: "accept",
    antiIdle: true,
    reconnectEnabled: true,
    reconnectMaxAttempts: 10,
    updateSeq: 0,
  });
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  // Log stream subscription (level filter + autoscroll)
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [minLevel, setMinLevel] = useState<"debug" | "info" | "warn" | "error">("info");
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const logger = getLogger();
    const load = () => setEntries(logger.snapshot());
    load();
    const off = logger.subscribe(() => load());
    return off;
  }, []);

  // Persist significant events (warnings and errors) to Convex so the history
  // survives reloads. Entries are already redacted by the logger.
  useEffect(() => {
    const last = entries.filter((e) => e.level === "warn" || e.level === "error").slice(-1)[0];
    if (!last) return;
    const key = `${last.at}-${last.message}`;
    if (recordedRef.current === key) return;
    recordedRef.current = key;
    void recordEvent({ at: last.at, level: last.level, scope: last.scope, message: last.message });
  }, [entries, recordEvent]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  // Sync Convex settings into the form.
  useEffect(() => {
    if (!settingsRaw) return;
    setForm({
      username: settingsRaw.username,
      hasPassword: settingsRaw.hasPassword,
      loginCommand: settingsRaw.loginCommand,
      registerCommand: settingsRaw.registerCommand,
      resourcePackPolicy: settingsRaw.resourcePackPolicy,
      antiIdle: settingsRaw.antiIdle,
      reconnectEnabled: settingsRaw.reconnectEnabled,
      reconnectMaxAttempts: settingsRaw.reconnectMaxAttempts,
      updateSeq: settingsRaw.updateSeq,
    });
  }, [settingsRaw]);

  useEffect(() => {
    if (settingsRaw === null) void ensureSettings({});
  }, [settingsRaw, ensureSettings]);

  const visibleEntries = useMemo(() => {
    const order = { debug: 0, info: 1, warn: 2, error: 3 };
    return entries.filter((e) => order[e.level] >= order[minLevel]).slice(-300);
  }, [entries, minLevel]);

  const execute = useCallback(
    (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      setHistory((h) => [...h.slice(-49), trimmed]);
      setHistoryIndex(-1);
      setCommand("");
      const result = runCommand(trimmed, {
        bot,
        connect: async () => {
          await bot.connect();
          toast.success("Connected", { description: `${bot.config.host}:${bot.config.port}` });
        },
        disconnect: (reason) => bot.disconnect(reason),
      });
      for (const line of result.lines) {
        if (result.ok) bot.logger.info("console", line);
        else bot.logger.warn("console", line);
      }
      if (!result.ok) {
        toast.error("Command failed", { description: result.lines[0] ?? "Unknown error" });
      }
    },
    [bot],
  );

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const result = await saveSettings({
        username: form.username,
        password: password.length > 0 ? password : undefined,
        loginCommand: form.loginCommand,
        registerCommand: form.registerCommand,
        resourcePackPolicy: form.resourcePackPolicy,
        antiIdle: form.antiIdle,
        reconnectEnabled: form.reconnectEnabled,
        reconnectMaxAttempts: form.reconnectMaxAttempts,
      });
      const problems = applySettings(form, password.length > 0 ? password : undefined);
      if (problems.length > 0) {
        toast.warning("Settings saved with warnings", { description: problems.join("; ") });
      } else {
        toast.success("Settings applied to the bot");
      }
      setPassword("");
      void result.updateSeq;
      setShowSettings(false);
    } catch (err) {
      toast.error("Save failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const conn = snapshot.connection;
  const connected = CONNECTED_STATES.includes(snapshot.activity) && conn !== null;
  const player = snapshot.player;
  const world = snapshot.world;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* TOP BAR */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary/10">
              <Bot className="size-5 text-primary" />
            </div>
            <div className="leading-tight">
              <p className="font-mono text-sm font-bold tracking-tight">PancakeBot console</p>
              <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                <Circle
                  className={`size-2 ${connected ? "fill-primary text-primary" : "text-muted-foreground"}`}
                />
                {snapshot.activity} · {bot.config.host}:{bot.config.port}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Dialog open={showSettings} onOpenChange={setShowSettings}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="cursor-pointer gap-1.5">
                  <Settings2 className="size-3.5" /> Settings
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Bot settings</DialogTitle>
                  <DialogDescription>
                    Stored per account. The password is saved only as a "configured" flag — the
                    secret itself never leaves your browser session.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="username">Bot username</Label>
                    <Input
                      id="username"
                      value={form.username}
                      onChange={(e) => setForm({ ...form, username: e.target.value })}
                      placeholder="PancakeBot"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="password">
                      Auth password{" "}
                      {form.hasPassword || botHasPassword() ? (
                        <span className="text-primary">(configured)</span>
                      ) : (
                        <span className="text-muted-foreground">(not set)</span>
                      )}
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={form.hasPassword ? "•••••••• (unchanged)" : "hunter2"}
                      autoComplete="off"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="loginCommand">Login command template</Label>
                    <Input
                      id="loginCommand"
                      value={form.loginCommand}
                      onChange={(e) => setForm({ ...form, loginCommand: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      {"{password}"} and {"{password2}"} are substituted before sending.
                    </p>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="registerCommand">Register command template</Label>
                    <Input
                      id="registerCommand"
                      value={form.registerCommand}
                      onChange={(e) => setForm({ ...form, registerCommand: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Resource-pack policy</Label>
                    <Select
                      value={form.resourcePackPolicy}
                      onValueChange={(v) => setForm({ ...form, resourcePackPolicy: v })}
                    >
                      <SelectTrigger className="cursor-pointer">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {POLICIES.map((p) => (
                          <SelectItem key={p.value} value={p.value}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border p-3">
                    <div>
                      <Label htmlFor="antiIdle">Anti-idle</Label>
                      <p className="text-xs text-muted-foreground">
                        Look around and swing when standing still.
                      </p>
                    </div>
                    <Switch
                      id="antiIdle"
                      checked={form.antiIdle}
                      onCheckedChange={(v) => setForm({ ...form, antiIdle: v })}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border p-3">
                    <div>
                      <Label htmlFor="reconnect">Auto-reconnect</Label>
                      <p className="text-xs text-muted-foreground">
                        Rejoin with backoff after disconnects.
                      </p>
                    </div>
                    <Switch
                      id="reconnect"
                      checked={form.reconnectEnabled}
                      onCheckedChange={(v) => setForm({ ...form, reconnectEnabled: v })}
                    />
                  </div>
                  {form.reconnectEnabled ? (
                    <div className="grid gap-1.5">
                      <Label htmlFor="maxAttempts">Max reconnect attempts</Label>
                      <Input
                        id="maxAttempts"
                        type="number"
                        min={1}
                        max={50}
                        value={form.reconnectMaxAttempts}
                        onChange={(e) =>
                          setForm({ ...form, reconnectMaxAttempts: Number(e.target.value) || 1 })
                        }
                      />
                    </div>
                  ) : null}
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    className="cursor-pointer"
                    onClick={() => setShowSettings(false)}
                  >
                    Cancel
                  </Button>
                  <Button className="cursor-pointer" onClick={handleSaveSettings} disabled={saving}>
                    {saving ? "Saving…" : "Save & apply"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button
              variant="ghost"
              size="sm"
              className="cursor-pointer gap-1.5"
              onClick={async () => {
                await signOut();
                navigate("/");
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
        {/* STATUS CARDS */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={Signal}
            label="Connection"
            value={conn ? `${conn.transport} · ${conn.phase}` : "not connected"}
            hint={conn ? String(conn.endpoint) : "type connect or press the button"}
            tone={connected ? "good" : snapshot.activity === "connecting" ? "warn" : "default"}
          />
          <StatCard
            icon={Compass}
            label="Position"
            value={`${player.x} ${player.y} ${player.z}`}
            hint={`${world.chunksLoaded} chunks · dim ${player.dimension || "?"}`}
          />
          <StatCard
            icon={Heart}
            label="Health / food"
            value={`${player.health.toFixed(1)} / ${player.food}`}
            hint={`${world.deaths} deaths · gm ${player.gamemode}`}
            tone={!player.alive ? "bad" : player.health <= 6 ? "warn" : "good"}
          />
          <StatCard
            icon={Package}
            label="Resource pack"
            value={String(snapshot.resourcePack.phase ?? "idle")}
            hint={
              snapshot.resourcePack.required === true
                ? "REQUIRED by server"
                : typeof snapshot.resourcePack.lastError === "string" &&
                    snapshot.resourcePack.lastError
                  ? snapshot.resourcePack.lastError
                  : `policy: ${bot.config.resourcePack.policy}`
            }
            tone={snapshot.resourcePack.required === true ? "warn" : "default"}
          />
        </section>

        {/* CONTROL BAR */}
        <section className="flex flex-wrap items-center gap-2">
          {connected ? (
            <Button
              variant="destructive"
              size="sm"
              className="cursor-pointer gap-1.5"
              onClick={() => execute("disconnect dashboard")}
            >
              <Square className="size-3.5" /> Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              className="cursor-pointer gap-1.5"
              onClick={() => execute("connect")}
            >
              <Play className="size-3.5" /> Connect
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer gap-1.5"
            onClick={() => execute("status")}
          >
            <Activity className="size-3.5" /> Status
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer gap-1.5"
            onClick={() => execute("players")}
          >
            <Users className="size-3.5" /> Players
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer gap-1.5"
            onClick={() => execute("auth")}
          >
            <Bot className="size-3.5" /> Auth detail
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="cursor-pointer gap-1.5"
            onClick={() => execute("resourcepack")}
          >
            <Package className="size-3.5" /> Pack detail
          </Button>
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Coffee className="size-3.5" />
            uptime {Math.floor(snapshot.stats.uptimeMs / 1000)}s
          </div>
        </section>

        {/* MAIN GRID */}
        <section className="grid gap-4 lg:grid-cols-3">
          {/* CONSOLE */}
          <Card className="border-border/70 shadow-none lg:col-span-2">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="size-4 text-primary" />
                  <CardTitle className="text-base">Console</CardTitle>
                </div>
                <Select
                  value={minLevel}
                  onValueChange={(v) => setMinLevel(v as typeof minLevel)}
                >
                  <SelectTrigger className="h-8 w-32 cursor-pointer text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="debug">debug+</SelectItem>
                    <SelectItem value="info">info+</SelectItem>
                    <SelectItem value="warn">warnings+</SelectItem>
                    <SelectItem value="error">errors only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <CardDescription>
                Same command set as the Termux CLI. Try{" "}
                <button
                  type="button"
                  className="cursor-pointer font-mono text-primary underline-offset-2 hover:underline"
                  onClick={() => execute("help")}
                >
                  help
                </button>
                ,{" "}
                <button
                  type="button"
                  className="cursor-pointer font-mono text-primary underline-offset-2 hover:underline"
                  onClick={() => execute("goto 0 64 0")}
                >
                  goto 0 64 0
                </button>
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div
                ref={logRef}
                className="mc-scanline h-80 overflow-y-auto rounded-lg border border-border bg-card/60 p-3 font-mono text-[11px] leading-5"
              >
                {visibleEntries.length === 0 ? (
                  <p className="text-muted-foreground">
                    No log lines at this level. Press Connect to start a session.
                  </p>
                ) : (
                  visibleEntries.map((entry, i) => (
                    <p key={`${entry.at}-${i}`} className="break-words">
                      <span className="text-muted-foreground">
                        [{new Date(entry.at).toLocaleTimeString()}]
                      </span>{" "}
                      <span className={LEVEL_COLORS[entry.level]}>
                        {entry.scope}/{entry.level[0]} {entry.message}
                      </span>
                    </p>
                  ))
                )}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="font-mono text-sm text-primary">$</span>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") execute(command);
                    else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
                      if (history[next] !== undefined) {
                        setHistoryIndex(next);
                        setCommand(history[next]);
                      }
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      if (historyIndex >= 0 && historyIndex < history.length - 1) {
                        setHistoryIndex(historyIndex + 1);
                        setCommand(history[historyIndex + 1]);
                      } else {
                        setHistoryIndex(-1);
                        setCommand("");
                      }
                    }
                  }}
                  placeholder="say hello, goto 100 64 -30, follow Steve…"
                  className="flex-1 font-mono text-sm"
                  autoComplete="off"
                />
                <Button size="sm" className="cursor-pointer gap-1" onClick={() => execute(command)}>
                  <Send className="size-3.5" /> Run
                </Button>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <button
                  type="button"
                  className="flex cursor-pointer items-center gap-1 hover:text-foreground"
                  onClick={() => setAutoScroll((v) => !v)}
                >
                  {autoScroll ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
                  auto-scroll {autoScroll ? "on" : "off"}
                </button>
                <button
                  type="button"
                  className="cursor-pointer hover:text-foreground"
                  onClick={() => void clearEvents({})}
                >
                  clear server log
                </button>
              </div>
            </CardContent>
          </Card>

          {/* SIDE PANELS */}
          <div className="flex flex-col gap-4">
            <Card className="border-border/70 shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Heart className="size-4 text-primary" /> Vitals
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-muted-foreground">Health</span>
                    <span>{player.health.toFixed(1)} / 20</span>
                  </div>
                  <Bar value={player.health} max={20} tone="bg-destructive/80" />
                </div>
                <div>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-muted-foreground">Food</span>
                    <span>{player.food} / 20</span>
                  </div>
                  <Bar value={player.food} max={20} tone="bg-chart-2" />
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1 text-xs text-muted-foreground">
                  <span>yaw {player.yaw}°</span>
                  <span>{player.onGround ? "on ground" : "airborne"}</span>
                  <span>items {world.collectedItems}</span>
                  <span>entities {world.entityCount}</span>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/70 shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="size-4 text-primary" /> Nearby
                </CardTitle>
              </CardHeader>
              <CardContent>
                {world.nearby.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No entities tracked yet. They appear once chunks load.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {world.nearby.slice(0, 6).map((e) => (
                      <li
                        key={e.id}
                        className="flex items-center justify-between rounded-md border border-border/70 px-2 py-1.5 text-xs"
                      >
                        <span className="truncate font-mono">
                          <span className={e.kind === "player" ? "text-primary" : ""}>
                            {e.name}
                          </span>
                          <span className="text-muted-foreground"> · {e.kind}</span>
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {e.distance}m
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/70 shadow-none">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <RefreshCw className="size-4 text-primary" /> Navigation
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>
                  goal:{" "}
                  <span className="text-foreground">
                    {snapshot.navigation.goal
                      ? `${snapshot.navigation.goal.x} ${snapshot.navigation.goal.y} ${snapshot.navigation.goal.z}`
                      : "none"}
                  </span>
                </p>
                <p>
                  path:{" "}
                  <span className="text-foreground">
                    {snapshot.navigation.hasPath
                      ? `step ${snapshot.navigation.pathIndex}/${snapshot.navigation.pathLength}`
                      : snapshot.navigation.lastPathResult ?? "idle"}
                  </span>
                </p>
                <p>
                  following:{" "}
                  <span className="text-foreground">{snapshot.navigation.following ?? "nobody"}</span>
                </p>
                <p>
                  auth: <span className="text-foreground">{String(snapshot.auth.status)}</span> ·
                  pack: <span className="text-foreground">{String(snapshot.resourcePack.phase)}</span>
                </p>
                {snapshot.stats.lastError ? (
                  <p className="text-destructive">last error: {snapshot.stats.lastError}</p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </section>

        {/* CHAT TAIL */}
        <section>
          <Card className="border-border/70 shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <PlayCircle className="size-4 text-primary" /> Recent chat
              </CardTitle>
              <CardDescription>
                Server and player chat, newest last. Use `say &lt;message&gt;` in the console.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {world.recentChat.length === 0 ? (
                <p className="text-sm text-muted-foreground">No chat yet.</p>
              ) : (
                <div className="max-h-40 space-y-1 overflow-y-auto font-mono text-xs">
                  {world.recentChat.slice(-30).map((line, i) => (
                    <p key={`${line.at}-${i}`} className="break-words">
                      <span className="text-muted-foreground">
                        {new Date(line.at).toLocaleTimeString()}
                      </span>{" "}
                      <span className="text-primary">{line.source}</span> {line.text}
                    </p>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}
