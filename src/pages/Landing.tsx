import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  Bot,
  Github,
  Heart,
  LogIn,
  type LucideIcon,
  MapPin,
  MessageSquare,
  Package,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Swords,
  Terminal,
  Users,
  Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";

const fadeIn = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0 },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: Wifi,
    title: "Full protocol stack",
    body: "Handshake, status ping with version detection, login, encryption, compression, configuration and play — implemented packet by packet for 1.21.x (protocol 774).",
  },
  {
    icon: ShieldCheck,
    title: "Auth & GUI logins",
    body: "Detects chat, title, bossbar and GUI login prompts, fills /login and /register from templates, and clicks through auth GUIs — secrets never appear in logs.",
  },
  {
    icon: Package,
    title: "Resource-pack aware",
    body: "Detect pack requests with URL/hash and required status. Policies: accept, decline, required-only, download-and-accept — with hashing, caching and timeouts.",
  },
  {
    icon: MapPin,
    title: "Pathfinding & movement",
    body: "Block-aware A* over the loaded world, walking, sprinting, jumping, following players, plus position/rotation tracking with teleport confirmation.",
  },
  {
    icon: Swords,
    title: "World interaction",
    body: "Block detection, breaking and placing, item pickup, inventory view, basic combat self-defence, health/hunger tracking, death and auto-respawn.",
  },
  {
    icon: RefreshCw,
    title: "Stays online",
    body: "Auto-reconnect with backoff, keep-alive handling, anti-idle look-around, and configurable commands — built to run all day on an Android phone in Termux.",
  },
];

const SIM_LINES = [
  "$ termux-wake-lock && bun src/bot/cli.ts",
  "✔ status ping → PancakeSMP 1.21.11 (protocol 774)",
  "✔ login accepted · compression 256 · configuration ok",
  "✔ resource pack → accept (policy: accept)",
  "✔ auth gui detected → submitting /login ********",
  "✔ play state reached · chunks streaming",
  "bot> goto 120 64 -84",
  "✔ pathing: 34 steps (A*, 512 nodes explored)",
];

function ConsoleMock() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, delay: 0.25 }}
      className="relative w-full max-w-xl rounded-xl border border-border bg-card/80 mc-scanline backdrop-blur"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="size-2.5 rounded-full bg-destructive/70" />
        <span className="size-2.5 rounded-full bg-chart-2/70" />
        <span className="size-2.5 rounded-full bg-primary/70" />
        <span className="ml-2 font-mono text-xs text-muted-foreground">
          pancakesmp — termux
        </span>
      </div>
      <div className="space-y-1.5 px-4 py-4 font-mono text-[11px] leading-5 sm:text-xs">
        {SIM_LINES.map((line, i) => (
          <motion.p
            key={line}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.5 + i * 0.22, duration: 0.35 }}
            className={
              line.startsWith("$")
                ? "text-primary"
                : line.startsWith("bot>")
                  ? "text-accent-foreground"
                  : "text-muted-foreground"
            }
          >
            {line}
          </motion.p>
        ))}
        <motion.span
          animate={{ opacity: [1, 0.2, 1] }}
          transition={{ repeat: Infinity, duration: 1.1 }}
          className="inline-block h-3.5 w-2 bg-primary align-middle"
        />
      </div>
    </motion.div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-border bg-card/60 px-4 py-3">
      <span className="text-lg font-bold tracking-tight text-primary sm:text-xl">{value}</span>
      <span className="text-center text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

export default function Landing() {
  const { isLoading, isAuthenticated } = useAuth();

  const dashboardLabel = isAuthenticated ? "Open dashboard" : "Launch the bot";
  const dashboardHref = isAuthenticated ? "/dashboard" : "/auth?returnTo=%2Fdashboard";

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={stagger}
      className="min-h-screen bg-background text-foreground"
    >
      {/* NAVBAR */}
      <motion.header
        variants={fadeIn}
        className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur"
      >
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
          <a href="/" className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary/10">
              <Bot className="size-5 text-primary" />
            </div>
            <span className="font-mono text-sm font-bold tracking-tight">
              PancakeBot<span className="text-primary">_</span>
            </span>
          </a>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#features" className="transition-colors hover:text-foreground">Features</a>
            <a href="#stack" className="transition-colors hover:text-foreground">How it works</a>
            <a href="#termux" className="transition-colors hover:text-foreground">Termux</a>
          </nav>
          <div className="flex items-center gap-2">
            {isLoading ? null : isAuthenticated ? (
              <Button asChild size="sm" className="cursor-pointer gap-1.5">
                <a href="/dashboard">
                  Dashboard <ArrowRight className="size-3.5" />
                </a>
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline" className="cursor-pointer gap-1.5">
                <a href="/auth">
                  <LogIn className="size-3.5" /> Sign in
                </a>
              </Button>
            )}
          </div>
        </div>
      </motion.header>

      {/* HERO */}
      <section className="mc-pixel-grid relative overflow-hidden">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 pb-16 pt-16 sm:pt-24 lg:grid-cols-2 lg:items-center">
          <motion.div variants={fadeIn} className="flex flex-col items-start gap-6">
            <Badge variant="outline" className="gap-1.5 border-primary/40 text-primary">
              <Activity className="size-3" />
              pancakesmp.kinetic.host:25565
            </Badge>
            <h1 className="text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
              A headless Minecraft bot that lives in{" "}
              <span className="text-primary">your terminal</span>
            </h1>
            <p className="max-w-lg text-base leading-7 text-muted-foreground sm:text-lg">
              PancakeBot speaks the real Minecraft Java protocol end to end — version detection,
              login GUIs, resource packs, pathfinding and combat — and reports every step to a live
              console dashboard. Light enough for Termux on an Android phone.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="cursor-pointer gap-2">
                <a href={dashboardHref}>
                  {dashboardLabel} <ArrowRight className="size-4" />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline" className="cursor-pointer gap-2">
                <a href="#stack">
                  <Terminal className="size-4" /> See how it works
                </a>
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 pt-2 font-mono text-[11px] text-muted-foreground">
              {["protocol 774", "1.21.11", "no external deps", "bun / node"].map((chip) => (
                <span key={chip} className="rounded border border-border bg-card/60 px-2 py-1">
                  {chip}
                </span>
              ))}
            </div>
          </motion.div>
          <div className="flex justify-center lg:justify-end">
            <ConsoleMock />
          </div>
        </div>
      </section>

      {/* STATS STRIP */}
      <motion.section variants={fadeIn} className="border-y border-border/70 bg-card/40">
        <div className="mx-auto grid w-full max-w-4xl grid-cols-2 gap-3 px-4 py-8 sm:grid-cols-4">
          <Stat value="774" label="protocol version" />
          <Stat value="1.21.x" label="target (auto-detected)" />
          <Stat value="100%" label="TypeScript, zero MC deps" />
          <Stat value="~1 MB" label="runtime footprint" />
        </div>
      </motion.section>

      {/* FEATURES */}
      <section id="features" className="mx-auto w-full max-w-6xl px-4 py-16 sm:py-20">
        <motion.div variants={fadeIn} className="mx-auto mb-10 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Everything a real client does</h2>
          <p className="mt-3 text-muted-foreground">
            Not a chat scraper — a genuine protocol implementation with the same connection
            sequence, screens and packets a vanilla client sends.
          </p>
        </motion.div>
        <motion.div variants={stagger} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <motion.div key={feature.title} variants={fadeIn}>
              <Card className="h-full border-border/70 shadow-none transition-colors hover:border-primary/40">
                <CardContent className="flex h-full flex-col gap-3 pt-6">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                    <feature.icon className="size-5 text-primary" />
                  </div>
                  <h3 className="font-semibold tracking-tight">{feature.title}</h3>
                  <p className="text-sm leading-6 text-muted-foreground">{feature.body}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </section>

      {/* HOW IT WORKS */}
      <section id="stack" className="border-y border-border/70 bg-card/40 mc-pixel-grid">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:py-20">
          <motion.div variants={fadeIn} className="mx-auto mb-10 max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">How it works</h2>
            <p className="mt-3 text-muted-foreground">
              One shared engine, two frontends: the web console here, and the Termux CLI that
              dials the real server over TCP.
            </p>
          </motion.div>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                icon: ServerCog,
                step: "01",
                title: "Detect the server",
                body: "A status ping asks pancakesmp.kinetic.host what it speaks. The reported version and protocol number configure the session — or you pin them in settings.",
              },
              {
                icon: MessageSquare,
                step: "02",
                title: "Survive the login gauntlet",
                body: "Resource-pack prompts, auth GUIs, sign editors, chat challenges — each is detected, acted on per your policy, and reported to the dashboard in plain language.",
              },
              {
                icon: Users,
                step: "03",
                title: "Play & watch",
                body: "Chunks stream in, pathfinding goes block-by-block, nearby players and entities stream to the dashboard, and every log line is redacted before it's shown.",
              },
            ].map((item) => (
              <motion.div key={item.step} variants={fadeIn}>
                <Card className="h-full border-border/70 shadow-none">
                  <CardContent className="flex h-full flex-col gap-3 pt-6">
                    <div className="flex items-center justify-between">
                      <div className="flex size-10 items-center justify-center rounded-lg bg-accent">
                        <item.icon className="size-5 text-accent-foreground" />
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">{item.step}</span>
                    </div>
                    <h3 className="font-semibold tracking-tight">{item.title}</h3>
                    <p className="text-sm leading-6 text-muted-foreground">{item.body}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* TERMUX SECTION */}
      <section id="termux" className="mx-auto w-full max-w-6xl px-4 py-16 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <motion.div variants={fadeIn} className="flex flex-col items-start gap-5">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Built for the phone in your pocket
            </h2>
            <p className="leading-7 text-muted-foreground">
              The CLI ships in this repo. Install Termux, grab Bun, and the bot is two commands
              away — the same engine that powers this dashboard, pointed at the real server:
            </p>
            <div className="w-full rounded-xl border border-border bg-card/80 p-4 font-mono text-xs leading-6">
              <p className="text-muted-foreground"># inside Termux</p>
              <p><span className="text-primary">$</span> pkg install bun git</p>
              <p><span className="text-primary">$</span> git clone &lt;this-repo&gt; pancakebot</p>
              <p><span className="text-primary">$</span> cd pancakebot && bun install</p>
              <p>
                <span className="text-primary">$</span> MC_PASSWORD=•••••••• bun src/bot/cli.ts
              </p>
              <p className="mt-2 text-muted-foreground">
                # dashboard appears right in the terminal — type `help`
              </p>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Passwords are passed by environment variable and redacted from every log line.
              The web dashboard stores only whether a password is set — never the secret itself.
            </p>
          </motion.div>
          <motion.div variants={fadeIn} className="grid grid-cols-2 gap-3">
            {[
              { icon: Terminal, title: "Console REPL", body: "connect, goto, follow, say, inventory, status — all in the dashboard and the CLI." },
              { icon: ShieldCheck, title: "Secret-safe", body: "A redaction layer sits between the bot and every output surface. Passwords structurally cannot leak." },
              { icon: Heart, title: "Lightweight", body: "Pure TypeScript with zlib from the platform — comfortable on a phone, no JVM required." },
              { icon: Github, title: "Hackable", body: "Clean modules: protocol, transport, core. Add commands or behaviors in a few lines." },
            ].map((item) => (
              <Card key={item.title} className="border-border/70 shadow-none">
                <CardContent className="flex h-full flex-col gap-2 pt-6">
                  <item.icon className="size-5 text-primary" />
                  <h3 className="text-sm font-semibold tracking-tight">{item.title}</h3>
                  <p className="text-xs leading-5 text-muted-foreground">{item.body}</p>
                </CardContent>
              </Card>
            ))}
          </motion.div>
        </div>
      </section>

      {/* FINAL CTA */}
      <motion.section variants={fadeIn} className="border-t border-border/70 bg-primary/5">
        <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 px-4 py-16 text-center sm:py-20">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Ready to send the bot in?
          </h2>
          <p className="max-w-xl text-muted-foreground">
            Sign in, configure credentials and pack policy, and watch the full connection sequence
            live — status ping to play state.
          </p>
          <Button asChild size="lg" className="cursor-pointer gap-2">
            <a href={dashboardHref}>
              {dashboardLabel} <ArrowRight className="size-4" />
            </a>
          </Button>
        </div>
      </motion.section>

      {/* FOOTER */}
      <footer className="border-t border-border/70">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-xs text-muted-foreground sm:flex-row">
          <span className="font-mono">PancakeBot — headless Minecraft Java client</span>
          <span>Not affiliated with Mojang or PancakeSMP. Play fair; respect server rules.</span>
        </div>
      </footer>
    </motion.div>
  );
}
