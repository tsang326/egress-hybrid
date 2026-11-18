// Draws the plan the way an evacuation plan is drawn: thick walls, green exits, then smoke and people on top.
import { HazardField } from "../../core/crowd/hazard";
import { STATE, type CrowdResult } from "../../core/crowd/types";
import { doorFace, doorState, type DrillScenario } from "../../core/plan/scenario";
import { OUTSIDE, floorsOf, roomById, type Plan } from "../../core/plan/types";

export const COLOURS = {
  paper: "#F7F8F6",
  ink: "#1C2226",
  wall: "#1C2226",
  corridor: "#E9EEEA",
  stair: "#E3E6EA",
  exit: "#00804A",
  fire: "#C62C1E",
  smoke: "52, 58, 64",
  heat: "214, 92, 30",
  queue: "#D99100",
  shelter: "#2C64B8",
  premove: "#6C757D",
  guide: "#00804A",
};

export interface View {
  plan: Plan;
  scenario: DrillScenario;
  hazard: HazardField | null;
  crowd: CrowdResult | null;
  timeS: number;
  selected: number | null;
}

interface FloorBox { floor: number; minX: number; minY: number; maxX: number; maxY: number; ox: number }

export class PlanRenderer {
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private boxes: FloorBox[] = [];
  private lastAgents: { id: number; x: number; y: number }[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  private layout(plan: Plan) {
    const MARGIN = 2.2, GAP = 4;
    let ox = 0;
    this.boxes = floorsOf(plan).map((f) => {
      const rs = plan.rooms.filter((r) => r.floor === f);
      const b = {
        floor: f,
        minX: Math.min(...rs.map((r) => r.x)) - MARGIN,
        minY: Math.min(...rs.map((r) => r.y)) - MARGIN - 1.2,
        maxX: Math.max(...rs.map((r) => r.x + r.widthM)) + MARGIN,
        maxY: Math.max(...rs.map((r) => r.y + r.depthM)) + MARGIN,
        ox: 0,
      };
      b.ox = ox - b.minX;
      ox += b.maxX - b.minX + GAP;
      return b;
    });
    const totalW = ox - GAP;
    const totalH = Math.max(...this.boxes.map((b) => b.maxY - b.minY));
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(200, rect.width), h = Math.max(160, rect.height);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.scale = Math.min(w / totalW, h / totalH) * dpr;
    this.ox = (this.canvas.width - totalW * this.scale) / 2;
    this.oy = (this.canvas.height - totalH * this.scale) / 2 - Math.min(...this.boxes.map((b) => b.minY)) * this.scale;
  }

  private px(floor: number, x: number, y: number): [number, number] {
    const b = this.boxes.find((bb) => bb.floor === floor) ?? this.boxes[0]!;
    return [this.ox + (x + b.ox) * this.scale, this.oy + y * this.scale];
  }

  draw(v: View) {
    const { ctx } = this;
    this.layout(v.plan);
    const s = this.scale;
    ctx.fillStyle = COLOURS.paper;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const multi = this.boxes.length > 1;

    // Floor titles
    ctx.fillStyle = COLOURS.premove;
    ctx.font = `600 ${Math.max(11, 0.75 * s)}px "Barlow Semi Condensed", sans-serif`;
    ctx.textBaseline = "alphabetic";
    if (multi) for (const b of this.boxes) {
      const [x, y] = this.px(b.floor, b.minX + 2.2, b.minY + 1.4);
      ctx.fillText(b.floor === 0 ? "Ground floor" : `Floor ${b.floor}`, x, y);
    }

    // Rooms, with smoke and heat at head height
    for (const r of v.plan.rooms) {
      const [x, y] = this.px(r.floor, r.x, r.y);
      const w = r.widthM * s, h = r.depthM * s;
      ctx.fillStyle = r.kind === "corridor" ? COLOURS.corridor : r.kind === "stair" ? COLOURS.stair : "#FFFFFF";
      ctx.fillRect(x, y, w, h);
      if (r.kind === "stair") {
        ctx.strokeStyle = "rgba(28,34,38,0.25)";
        ctx.lineWidth = Math.max(1, 0.05 * s);
        const steps = Math.max(3, Math.floor(r.depthM / 0.3));
        ctx.beginPath();
        for (let i = 1; i < steps; i++) { ctx.moveTo(x + w * 0.15, y + (h * i) / steps); ctx.lineTo(x + w * 0.85, y + (h * i) / steps); }
        ctx.stroke();
      }
      if (v.hazard) {
        const e = v.hazard.at(r.id, v.timeS);
        const smoke = Math.max(0, Math.min(1, (30 - e.visibilityM) / 27));
        if (smoke > 0.02) { ctx.fillStyle = `rgba(${COLOURS.smoke}, ${0.12 + 0.6 * smoke})`; ctx.fillRect(x, y, w, h); }
        const heat = Math.max(0, Math.min(1, (e.tempC - 40) / 100));
        if (heat > 0.02) { ctx.fillStyle = `rgba(${COLOURS.heat}, ${0.45 * heat})`; ctx.fillRect(x, y, w, h); }
      }
    }

    // Walls
    ctx.strokeStyle = COLOURS.wall;
    ctx.lineWidth = Math.max(2, 0.22 * s);
    ctx.lineJoin = "miter";
    for (const r of v.plan.rooms) {
      const [x, y] = this.px(r.floor, r.x, r.y);
      ctx.strokeRect(x, y, r.widthM * s, r.depthM * s);
    }

    // Doors
    for (const d of v.plan.doors) {
      const ra = roomById(v.plan, d.a);
      if (!ra) continue;
      const state = doorState(d, v.scenario);
      if (d.stair) {
        const [x, y] = this.px(ra.floor, d.x, d.y);
        ctx.fillStyle = COLOURS.ink;
        ctx.font = `600 ${Math.max(10, 0.6 * s)}px "Barlow Semi Condensed", sans-serif`;
        ctx.textAlign = "center";
        const other = roomById(v.plan, d.b);
        ctx.fillText(other && other.floor > ra.floor ? "Stairs up" : "Stairs down", x, y);
        if (other) {
          const [x2, y2] = this.px(other.floor, d.x, d.y);
          ctx.fillText(other.floor > ra.floor ? "Stairs down" : "Stairs up", x2, y2);
        }
        ctx.textAlign = "left";
        continue;
      }
      const { face } = doorFace(ra, d);
      const horiz = face === "front" || face === "back";
      const [cx, cy] = this.px(ra.floor, d.x, d.y);
      const half = (d.widthM / 2) * s;
      const t = Math.max(3, 0.34 * s);
      ctx.fillStyle = "#FFFFFF";
      if (horiz) ctx.fillRect(cx - half, cy - t / 2, half * 2, t); else ctx.fillRect(cx - t / 2, cy - half, t, half * 2);
      const exit = d.b === OUTSIDE;
      if (state === "closed" || state === "locked") {
        ctx.strokeStyle = state === "locked" ? COLOURS.fire : COLOURS.ink;
        ctx.lineWidth = Math.max(1.5, 0.08 * s);
        ctx.beginPath();
        if (horiz) { ctx.moveTo(cx - half, cy); ctx.lineTo(cx + half, cy); } else { ctx.moveTo(cx, cy - half); ctx.lineTo(cx, cy + half); }
        ctx.stroke();
      }
      if (exit) {
        // Exit marker outside the wall: a green bar, and a sign block where the plan has a lit sign.
        const out = face === "front" ? [0, -1] : face === "back" ? [0, 1] : face === "left" ? [-1, 0] : [1, 0];
        const mx = cx + out[0]! * 0.7 * s, my = cy + out[1]! * 0.7 * s;
        ctx.fillStyle = state === "locked" ? COLOURS.fire : COLOURS.exit;
        const bw = horiz ? half * 2 : 0.32 * s, bh = horiz ? 0.32 * s : half * 2;
        ctx.fillRect(mx - bw / 2, my - bh / 2, bw, bh);
        if (d.exitSign && state !== "locked") {
          const sx = cx + out[0]! * 1.5 * s, sy = cy + out[1]! * 1.5 * s;
          drawExitSign(ctx, sx, sy, 0.95 * s);
        }
      }
      if (state === "locked") {
        const k = Math.max(5, 0.45 * s);
        ctx.strokeStyle = COLOURS.fire;
        ctx.lineWidth = Math.max(2, 0.14 * s);
        ctx.beginPath();
        ctx.moveTo(cx - k, cy - k); ctx.lineTo(cx + k, cy + k); ctx.moveTo(cx + k, cy - k); ctx.lineTo(cx - k, cy + k);
        ctx.stroke();
      }
      ctx.fillStyle = COLOURS.premove;
      ctx.font = `500 ${Math.max(9, 0.5 * s)}px "Barlow Semi Condensed", sans-serif`;
      const off = horiz ? [half + 3, -3] : [4, -half - 3];
      ctx.fillText(d.id, cx + off[0]!, cy + off[1]!);
    }

    // Room names
    ctx.fillStyle = COLOURS.ink;
    for (const r of v.plan.rooms) {
      const [x, y] = this.px(r.floor, r.x, r.y);
      const size = Math.max(10, Math.min(0.7 * s, (r.widthM * s) / Math.max(6, r.name.length * 0.62)));
      ctx.font = `600 ${size}px "Barlow Semi Condensed", sans-serif`;
      ctx.fillText(r.name, x + 0.4 * s, y + 0.4 * s + size);
      if (r.staffOnly) {
        ctx.fillStyle = COLOURS.premove;
        ctx.font = `500 ${size * 0.8}px "Barlow Semi Condensed", sans-serif`;
        ctx.fillText("Staff only", x + 0.4 * s, y + 0.4 * s + size * 2);
        ctx.fillStyle = COLOURS.ink;
      }
    }

    // Fire
    const fr = roomById(v.plan, v.scenario.fire.room);
    if (fr && v.timeS >= (v.scenario.fire.startS ?? 0)) {
      const [x, y] = this.px(fr.floor, fr.x + fr.widthM / 2, fr.y + fr.depthM / 2);
      const grow = Math.min(1, (v.timeS - (v.scenario.fire.startS ?? 0)) / 120);
      drawFlame(ctx, x, y + 0.4 * s, (0.35 + 0.4 * grow) * s);
    }

    // People
    this.lastAgents = [];
    const frames = v.crowd?.frames;
    if (frames && frames.length) {
      const i = Math.min(frames.length - 1, Math.max(0, Math.floor(v.timeS / v.crowd!.frameDtS)));
      const f = frames[i]!;
      const r = Math.max(2.2, 0.27 * s);
      for (let k = 0; k < f.length / 4; k++) {
        const st = f[k * 4 + 3]!;
        if (st === STATE.out) continue;
        const [x, y] = this.px(f[k * 4 + 2]!, f[k * 4]!, f[k * 4 + 1]!);
        this.lastAgents.push({ id: k, x, y });
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        if (st === STATE.premove) { ctx.fillStyle = "#FFFFFF"; ctx.fill(); ctx.strokeStyle = COLOURS.premove; ctx.lineWidth = Math.max(1, r * 0.4); ctx.stroke(); }
        else if (st === STATE.incapacitated) { ctx.fillStyle = COLOURS.fire; ctx.fill(); }
        else if (st === STATE.sheltering) { ctx.fillStyle = COLOURS.shelter; ctx.fill(); }
        else if (st === STATE.queue) { ctx.fillStyle = COLOURS.queue; ctx.fill(); }
        else if (st === STATE.busy) { ctx.fillStyle = COLOURS.guide; ctx.fill(); }
        else { ctx.fillStyle = COLOURS.ink; ctx.fill(); }
        if (v.selected === k) {
          ctx.beginPath();
          ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
          ctx.strokeStyle = COLOURS.ink;
          ctx.lineWidth = Math.max(1.5, r * 0.35);
          ctx.stroke();
        }
      }
    }
  }

  /** The person nearest a click, in CSS pixels relative to the canvas. */
  pick(cssX: number, cssY: number): number | null {
    const dpr = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width);
    const x = cssX * dpr, y = cssY * dpr;
    let best: number | null = null, bd = (14 * dpr) ** 2;
    for (const a of this.lastAgents) {
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bd) { bd = d; best = a.id; }
    }
    return best;
  }
}

function drawExitSign(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.fillStyle = COLOURS.exit;
  ctx.fillRect(x - size / 2, y - size / 2, size, size);
  // A simple running figure and arrow, white on green
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = Math.max(1.2, size * 0.09);
  ctx.lineCap = "round";
  const u = size / 10;
  ctx.beginPath();
  ctx.arc(x - 0.5 * u, y - 3 * u, 0.9 * u, 0, Math.PI * 2);
  ctx.moveTo(x - 1 * u, y - 1.6 * u); ctx.lineTo(x - 2 * u, y + 1 * u); // body
  ctx.moveTo(x - 2 * u, y + 1 * u); ctx.lineTo(x - 0.4 * u, y + 3.4 * u); // front leg
  ctx.moveTo(x - 2 * u, y + 1 * u); ctx.lineTo(x - 3.8 * u, y + 2.6 * u); // back leg
  ctx.moveTo(x - 1.2 * u, y - 1 * u); ctx.lineTo(x + 0.8 * u, y - 0.2 * u); // arm
  ctx.moveTo(x + 1.6 * u, y + 1.2 * u); ctx.lineTo(x + 3.8 * u, y + 1.2 * u); // arrow
  ctx.moveTo(x + 3 * u, y + 0.3 * u); ctx.lineTo(x + 3.8 * u, y + 1.2 * u); ctx.lineTo(x + 3 * u, y + 2.1 * u);
  ctx.stroke();
  ctx.lineCap = "butt";
}

function drawFlame(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.fillStyle = COLOURS.fire;
  ctx.beginPath();
  ctx.moveTo(x, y - r * 1.3);
  ctx.bezierCurveTo(x + r * 0.9, y - r * 0.4, x + r * 0.9, y + r * 0.7, x, y + r * 0.8);
  ctx.bezierCurveTo(x - r * 0.9, y + r * 0.7, x - r * 0.9, y - r * 0.2, x - r * 0.3, y - r * 0.6);
  ctx.bezierCurveTo(x - r * 0.2, y - r * 0.2, x, y - r * 0.4, x, y - r * 1.3);
  ctx.fill();
  ctx.fillStyle = "#FFD27A";
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.35, r * 0.3, r * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
}
