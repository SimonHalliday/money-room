import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { supabase } from "./supabaseClient";
import {
  Wallet, CalendarClock, ShoppingBag, Landmark, Settings2,
  Plus, Trash2, Check, ArrowDownCircle, X, Sparkles, Banknote, Pencil,
  Briefcase, AlertTriangle, CreditCard, Upload, ChevronUp, ChevronDown, Eye, EyeOff,
} from "lucide-react";
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  AreaChart, Area, XAxis, YAxis, ReferenceLine,
} from "recharts";
import * as pdfjsLib from "pdfjs-dist";

// PDF text is extracted in the browser, then sent as plain text (the path that
// works) instead of a heavy raw-PDF upload. The worker is pulled from a CDN at
// the exact installed version, so it can never version-mismatch the library.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "ww-money-v3";

const ACCOUNT_COLORS = [
  "#0d9488", "#4f46e5", "#db2777", "#ea580c",
  "#0891b2", "#65a30d", "#7c3aed", "#475569",
];

const CATEGORIES = [
  "Groceries", "Eating out", "Fuel / transport", "Shopping",
  "Subscriptions", "Kids", "Health", "Home", "Fun", "Other",
];

const CATEGORY_COLOURS = {
  "Groceries": "#0d9488", "Eating out": "#ea580c", "Fuel / transport": "#4f46e5",
  "Shopping": "#db2777", "Subscriptions": "#7c3aed", "Kids": "#0891b2",
  "Health": "#65a30d", "Home": "#b45309", "Fun": "#e11d48", "Other": "#64748b",
};

const DRAW_TYPES = ["Salary", "Dividend", "Director's loan / ad-hoc", "Expense refund", "Other"];

const DRAW_TYPE_COLOURS = {
  "Salary": "#0d9488",
  "Dividend": "#4f46e5",
  "Director's loan / ad-hoc": "#d97706",
  "Expense refund": "#64748b",
  "Other": "#a8a29e",
};

const analysisPrompt = (cats) =>
  'You are analysing a personal bank statement. Read the statement data and reply with ONLY a single minified JSON object — no markdown, no backticks, no commentary — in exactly this shape: ' +
  '{"currency":"GBP","period":"<human date range or empty string>","totalIn":<number>,"totalOut":<number>,' +
  '"byCategory":[{"category":"<' + cats.join("|") + '>","amount":<number>,"items":[{"description":"<payee>","amount":<number>,"date":"<DD Mon or empty>"}]}],' +
  '"recurring":[{"name":"<payee>","amount":<number>,"cadence":"monthly|weekly|annual","type":"bill|subscription","dayOfMonth":<1-31 or null>}],' +
  '"largest":[{"description":"<payee>","amount":<number>,"date":"<DD Mon or empty>"}],' +
  '"insights":["<short plain-English note>"]}. ' +
  'Rules: all amounts are positive plain numbers in pounds, no symbols. Use ONLY these categories and nothing else: ' + cats.join(", ") + '. If a transaction does not clearly fit one, choose the closest of those. byCategory covers money going OUT only, top 8 by amount, and each category includes an items array listing every individual transaction in it (description, amount, date). ' +
  'recurring lists payments that look like they repeat (direct debits, standing orders, subscriptions), up to 10, with a best-guess cadence and a day-of-month if monthly. ' +
  'largest lists the top 5 one-off outgoings. insights gives 3 to 5 friendly, practical notes for someone managing money with ADHD — flag subscriptions they may not need, categories higher than expected, or simple wins. Be encouraging, never preachy or shaming. If a value is unknown use 0 or "". Output JSON only.';

const EMPTY = {
  accounts: [],
  bills: [],
  transactions: [],
  loans: [],
  draws: [],
  cards: [],
  pots: [],
  reserve: 0,
  business: { accounts: [], loans: [], bills: [] },
  businessEnabled: true,
  categories: [...CATEGORIES],
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 10);

const gbp = (n) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency", currency: "GBP",
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);

const gbp0 = (n) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency", currency: "GBP",
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(Number.isFinite(n) ? n : 0);

function localISO(d = new Date()) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

// "YYYY-MM" for the given date, used to mark a bill paid for a specific month.
function monthKey(d = new Date()) {
  return localISO(d).slice(0, 7);
}

function nextDue(day) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const y = today.getFullYear();
  const m = today.getMonth();
  const lastOf = (yy, mm) => new Date(yy, mm + 1, 0).getDate();
  let cand = new Date(y, m, Math.min(day, lastOf(y, m)));
  if (cand < today) {
    const nm = m + 1;
    cand = new Date(y, nm, Math.min(day, lastOf(y, nm)));
  }
  return cand;
}

function daysUntil(date) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.round((date - t) / 86400000);
}

// Project the running account balance forward, subtracting bills on the days they fall due.
// Returns the daily points plus the lowest point and the date it happens.
function buildProjection(startBalance, bills, days = 42) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const thisMK = monthKey(today);
  const lastOf = (yy, mm) => new Date(yy, mm + 1, 0).getDate();
  const end = new Date(today); end.setDate(today.getDate() + days);
  const dropByOffset = {};
  (bills || []).forEach((b) => {
    const amt = Number(b.amount) || 0;
    const dom = Number(b.day) || 0;
    if (!amt || !dom) return;
    for (let k = 0; k <= 2; k++) {
      if (k === 0 && b.paidMonth === thisMK) continue; // already paid this month — don't subtract again
      const yy = today.getFullYear();
      const mm = today.getMonth() + k;
      const due = new Date(yy, mm, Math.min(dom, lastOf(yy, mm)));
      if (due >= today && due <= end) {
        const off = Math.round((due - today) / 86400000);
        dropByOffset[off] = (dropByOffset[off] || 0) + amt;
      }
    }
  });
  const points = [];
  let bal = startBalance;
  let low = startBalance;
  let lowOff = 0;
  for (let i = 0; i <= days; i++) {
    if (i > 0 && dropByOffset[i]) bal -= dropByOffset[i];
    if (bal < low) { low = bal; lowOff = i; }
    const d = new Date(today); d.setDate(today.getDate() + i);
    points.push({
      off: i,
      label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      balance: Math.round(bal * 100) / 100,
      drop: dropByOffset[i] || 0,
    });
  }
  const lowDate = new Date(today); lowDate.setDate(today.getDate() + lowOff);
  return { points, low: Math.round(low * 100) / 100, lowDate, lowOff };
}

function isThisMonth(iso) {
  const d = new Date(iso + "T00:00:00");
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
}

function isThisYear(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.getFullYear() === new Date().getFullYear();
}

function dateInThisMonth(date) {
  const n = new Date();
  return date.getFullYear() === n.getFullYear() && date.getMonth() === n.getMonth();
}

const dueLabel = (n) => (n === 0 ? "Today" : n === 1 ? "Tomorrow" : `in ${n} days`);
const balanceOf = (a) => (Number.isFinite(a.balance) ? a.balance : 0);

// Per-category spend for this month vs last month, from logged transactions.
function categoryTrends(transactions) {
  const now = new Date();
  const thisY = now.getFullYear(), thisM = now.getMonth();
  const lastM = thisM === 0 ? 11 : thisM - 1;
  const lastY = thisM === 0 ? thisY - 1 : thisY;
  const inMonth = (iso, y, m) => {
    if (!iso) return false;
    const d = new Date(iso + "T00:00:00");
    return d.getFullYear() === y && d.getMonth() === m;
  };
  const a = {}, b = {};
  (transactions || []).forEach((t) => {
    if (inMonth(t.date, thisY, thisM)) a[t.category] = (a[t.category] || 0) + (t.amount || 0);
    else if (inMonth(t.date, lastY, lastM)) b[t.category] = (b[t.category] || 0) + (t.amount || 0);
  });
  return Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
    .map((c) => ({ category: c, now: a[c] || 0, prev: b[c] || 0 }))
    .filter((x) => x.now > 0 || x.prev > 0)
    .sort((x, y2) => y2.now - x.now);
}
const owedOn = (l) =>
  Math.max(0, (l.original || 0) - l.payments.reduce((s, p) => s + (p.amount || 0), 0));

/* months until a loan is cleared. Uses APR amortisation if apr>0, else straight-line. */
function monthsLeft(remaining, monthly, apr) {
  if (!(monthly > 0) || remaining <= 0) return remaining <= 0 ? 0 : null;
  const r = apr && apr > 0 ? apr / 100 / 12 : 0;
  if (r === 0) return Math.ceil(remaining / monthly);
  if (monthly <= remaining * r) return Infinity; // payment doesn't cover interest
  const n = -Math.log(1 - (remaining * r) / monthly) / Math.log(1 + r);
  return Math.ceil(n);
}

function termLabel(m) {
  if (m === null) return null;
  if (m === 0) return "cleared";
  if (m === Infinity) return "payment too low";
  const y = Math.floor(m / 12);
  const mo = m % 12;
  if (y === 0) return `${mo} mo`;
  if (mo === 0) return `${y} yr`;
  return `${y} yr ${mo} mo`;
}

function payoffDate(m) {
  if (m === null || m === Infinity || m === 0) return null;
  const d = new Date();
  d.setMonth(d.getMonth() + m);
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

/* build a short, prioritised list of gentle action prompts from current state */
function buildNudges(data) {
  const out = [];
  data.accounts.forEach((a) => {
    const dueSoon = data.bills
      .filter((b) => b.accountId === a.id && daysUntil(nextDue(b.day)) <= 5)
      .reduce((s, b) => s + (b.amount || 0), 0);
    if (dueSoon > 0 && balanceOf(a) < dueSoon) {
      out.push({ id: "fund-" + a.id, tone: "warn",
        text: `${a.name}: ${gbp0(dueSoon)} of bills due in the next few days, but only ${gbp0(balanceOf(a))} in there.` });
    }
  });
  (data.cards || []).forEach((c) => {
    const owed = Math.max(0, c.balance || 0);
    if (owed > 0 && c.minPayment > 0 && monthsLeft(owed, c.minPayment, c.apr) === Infinity) {
      out.push({ id: "cardint-" + c.id, tone: "warn",
        text: `${c.name}'s minimum barely covers the interest — paying a little more would actually shrink it.` });
    } else if (c.limit > 0 && owed > c.limit) {
      out.push({ id: "cardover-" + c.id, tone: "warn", text: `${c.name} is over its limit.` });
    } else if (c.limit > 0 && owed / c.limit >= 0.9) {
      out.push({ id: "cardutil-" + c.id, tone: "info",
        text: `${c.name} is nearly maxed (${Math.round((owed / c.limit) * 100)}% used).` });
    }
  });
  if (data.transactions.length > 0) {
    const last = data.transactions.reduce((mx, t) => (t.date > mx ? t.date : mx), "");
    if (last) {
      const since = -daysUntil(new Date(last + "T00:00:00"));
      if (since >= 7) out.push({ id: "stale", tone: "info",
        text: `No spending logged in ${since} days — pull in a statement to catch up without the typing.` });
    }
  }
  data.loans.forEach((l) => {
    const owed = owedOn(l);
    if (owed > 0 && (l.monthly || 0) > 0 && owed <= l.monthly * 2) {
      const n = Math.ceil(owed / l.monthly);
      out.push({ id: "loandone-" + l.id, tone: "good",
        text: `Nearly there on ${l.name} — about ${n} payment${n === 1 ? "" : "s"} left!` });
    }
  });
  const rank = { warn: 0, good: 1, info: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]).slice(0, 5);
}

/* build an iCalendar file of monthly bill reminders */
function icsForBills(bills) {
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//The Money Room//Bills//EN", "CALSCALE:GREGORIAN"];
  bills.forEach((b) => {
    const day = Math.min(28, Math.max(1, b.day || 1));
    const due = nextDue(day);
    const date = `${due.getFullYear()}${pad(due.getMonth() + 1)}${pad(due.getDate())}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${b.id}@money-room`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${date}`,
      `RRULE:FREQ=MONTHLY;BYMONTHDAY=${day}`,
      `SUMMARY:${b.name} — ${gbp(b.amount)} due`,
      "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", `DESCRIPTION:${b.name} due tomorrow`, "END:VALARM",
      "END:VEVENT"
    );
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function makeExample() {
  const n = new Date();
  const y = n.getFullYear();
  const m = n.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  const d = (day) => localISO(new Date(y, m, Math.min(day, last)));
  return {
    reserve: 800,
    accounts: [
      { id: "a1", name: "Personal current", type: "Current", color: "#0d9488", balance: 1240 },
      { id: "a2", name: "Bills account", type: "Current", color: "#4f46e5", balance: 610 },
    ],
    bills: [
      { id: "b1", name: "Mortgage", amount: 850, day: 1, accountId: "a2" },
      { id: "b2", name: "Council tax", amount: 165, day: 5, accountId: "a2" },
      { id: "b3", name: "Energy", amount: 140, day: 12, accountId: "a2" },
      { id: "b4", name: "Broadband", amount: 35, day: 18, accountId: "a2" },
      { id: "b5", name: "Phone", amount: 22, day: 20, accountId: "a1" },
      { id: "b6", name: "Streaming bundle", amount: 18, day: 24, accountId: "a1" },
    ],
    transactions: [],
    loans: [
      { id: "l1", name: "Car finance", original: 6800, monthly: 245, apr: 8.9, accountId: "a1", payments: [] },
    ],
    draws: [
      { id: uid(), date: d(1), amount: 750, type: "Salary", accountId: "a1", note: "Monthly PAYE", applied: false },
      { id: uid(), date: d(13), amount: 1200, type: "Dividend", accountId: "a1", note: "", applied: false },
    ],
    cards: [
      { id: "c1", name: "Visa", balance: 1850, limit: 5000, apr: 22.9, minPayment: 55, color: "#7c3aed", payments: [] },
      { id: "c2", name: "Store card", balance: 320, limit: 1000, apr: 27.9, minPayment: 25, color: "#ea580c", payments: [] },
    ],
    pots: [
      { id: "p1", name: "Christmas", target: 600, saved: 150, color: "#db2777" },
      { id: "p2", name: "Car service / MOT", target: 400, saved: 220, color: "#0891b2" },
      { id: "p3", name: "Annual insurance", target: 720, saved: 300, color: "#65a30d" },
    ],
    business: {
      accounts: [
        { id: "ba1", name: "Business current", type: "Current", color: "#0891b2", balance: 9200 },
        { id: "ba2", name: "Business reserve", type: "Savings", color: "#65a30d", balance: 4100 },
      ],
      loans: [
        { id: "bl1", name: "Equipment finance", original: 14200, monthly: 465, apr: 7.5, accountId: "ba1", payments: [] },
        { id: "bl2", name: "Van / asset finance", original: 9800, monthly: 320, apr: 6.9, accountId: "ba1", payments: [] },
        { id: "bl3", name: "Business loan", original: 22000, monthly: 410, apr: 9.5, accountId: "ba1", payments: [] },
      ],
    },
  };
}

/* ------------------------------------------------------------------ */
/*  UI atoms                                                           */
/* ------------------------------------------------------------------ */

const Eyebrow = ({ children }) => (
  <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">{children}</p>
);

const Card = ({ children, className = "" }) => (
  <div className={`rounded-3xl border border-stone-200 bg-white p-5 shadow-sm ${className}`}>{children}</div>
);

const Dot = ({ color }) => (
  <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />
);

const Stat = ({ label, value, accent }) => (
  <div className="rounded-2xl border border-stone-200 bg-white p-3.5">
    <p className="text-xs text-slate-400">{label}</p>
    <p className={`mt-1 text-xl font-bold tabular-nums ${accent || "text-slate-900"}`}>{value}</p>
  </div>
);

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100";

const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-700 active:scale-95";

const btnGhost =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-stone-50";

// A small reusable edit dialog. `fields` describes the inputs; on Save it hands
// the caller an object of the edited values (number fields parsed to numbers).
function SignedMoneyInput({ value, onChange }) {
  const initial = Number(value) || 0;
  const [neg, setNeg] = useState(initial < 0);
  const [mag, setMag] = useState(value === "" || value == null ? "" : String(Math.abs(initial)));
  useEffect(() => {
    if (value === "" || value == null) { setMag(""); setNeg(false); }
  }, [value]);
  const emit = (negVal, magVal) => {
    const m = parseFloat(magVal);
    onChange(magVal === "" || !Number.isFinite(m) ? 0 : (negVal ? -Math.abs(m) : Math.abs(m)));
  };
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => { const n = !neg; setNeg(n); emit(n, mag); }}
        title={neg ? "Negative (overdrawn) — tap to flip" : "Positive — tap to flip"}
        className={`flex h-10 w-12 shrink-0 items-center justify-center rounded-xl border text-lg font-bold transition ${neg ? "border-rose-300 bg-rose-50 text-rose-600" : "border-stone-200 bg-stone-50 text-slate-500"}`}
      >
        {neg ? "−" : "+"}
      </button>
      <input
        className={inputCls}
        type="number"
        inputMode="decimal"
        step="0.01"
        placeholder="0.00"
        value={mag}
        onChange={(e) => { setMag(e.target.value); emit(neg, e.target.value); }}
      />
    </div>
  );
}

function EditModal({ title, fields, item, onSave, onClose }) {
  const [draft, setDraft] = useState(() => {
    const d = {};
    fields.forEach((f) => {
      const v = item ? item[f.key] : undefined;
      d[f.key] = v ?? (f.type === "select" ? (f.options[0]?.value ?? "") : f.type === "toggle" ? false : "");
    });
    return d;
  });
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const save = () => {
    const out = {};
    fields.forEach((f) => {
      let v = draft[f.key];
      if (f.type === "money" || f.type === "number" || f.type === "percent")
        v = v === "" || v == null ? 0 : Number(v);
      out[f.key] = v;
    });
    onSave(out);
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1 text-slate-400 transition hover:bg-stone-100">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          {fields.map((f) => (
            <Field key={f.key} label={f.label}>
              {f.type === "signedmoney" ? (
                <SignedMoneyInput value={draft[f.key]} onChange={(v) => set(f.key, v)} />
              ) : f.type === "toggle" ? (
                <button
                  type="button"
                  onClick={() => set(f.key, !draft[f.key])}
                  className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-sm font-medium transition ${draft[f.key] ? "border-teal-300 bg-teal-50 text-teal-700" : "border-stone-200 bg-stone-50 text-slate-500"}`}
                >
                  <span>{draft[f.key] ? "Yes" : "No"}</span>
                  <span className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${draft[f.key] ? "justify-end bg-teal-600" : "justify-start bg-stone-300"}`}>
                    <span className="block h-4 w-4 rounded-full bg-white shadow-sm" />
                  </span>
                </button>
              ) : f.type === "select" ? (
                <select className={inputCls} value={draft[f.key]} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  className={inputCls}
                  type={f.type === "text" ? "text" : f.type === "date" ? "date" : "number"}
                  inputMode={f.type === "text" || f.type === "date" ? undefined : "decimal"}
                  step={f.type === "money" || f.type === "percent" ? "0.01" : f.type === "number" ? "1" : undefined}
                  value={draft[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
            </Field>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className={`${btnGhost} flex-1`}>Cancel</button>
          <button onClick={save} className={`${btnPrimary} flex-1`}>Save</button>
        </div>
      </div>
    </div>
  );
}

// Small pencil button used in lists to open the edit dialog.
function EditBtn({ onClick }) {
  return (
    <button onClick={onClick} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-stone-100 hover:text-slate-600">
      <Pencil size={15} />
    </button>
  );
}

function CheckToggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-2.5 rounded-xl bg-stone-50 px-3 py-2.5 text-left"
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${
          checked ? "border-teal-600 bg-teal-600 text-white" : "border-stone-300 bg-white"
        }`}
      >
        {checked && <Check size={13} strokeWidth={3} />}
      </span>
      <span className="text-sm text-slate-600">{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

const NAV = [
  { id: "home", label: "Today", icon: Wallet },
  { id: "income", label: "Income", icon: Banknote },
  { id: "bills", label: "Bills", icon: CalendarClock },
  { id: "spend", label: "Spend", icon: ShoppingBag },
  { id: "loans", label: "Debt", icon: Landmark },
  { id: "setup", label: "More", icon: Settings2 },
];

// A floating button + minimal sheet for logging a spend from anywhere in two taps.
function QuickAdd({ data, patch }) {
  const accounts = data.accounts || [];
  const cards = data.cards || [];
  const cats = data.categories?.length ? data.categories : CATEGORIES;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(cats[0]);
  const [srcVal, setSrcVal] = useState(accounts[0] ? `a:${accounts[0].id}` : cards[0] ? `c:${cards[0].id}` : "");

  if (accounts.length === 0 && cards.length === 0) return null;

  const sources = [
    ...accounts.map((a) => ({ value: `a:${a.id}`, label: a.name })),
    ...cards.map((c) => ({ value: `c:${c.id}`, label: `${c.name} (card)` })),
  ];

  const save = () => {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0 || !srcVal) return;
    const isCard = srcVal.startsWith("c:");
    const accId = srcVal.slice(2);
    patch((d) => {
      d.transactions = d.transactions || [];
      d.transactions.push({ id: uid(), amount: amt, category, accountId: accId, isCard, date: localISO(), note: "", applied: true });
      if (isCard) { const c = (d.cards || []).find((x) => x.id === accId); if (c) c.balance = (c.balance || 0) + amt; }
      else { const a = (d.accounts || []).find((x) => x.id === accId); if (a) a.balance = balanceOf(a) - amt; }
      return d;
    });
    setAmount(""); setCategory(cats[0]); setOpen(false);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Quick add spend"
        className="fixed bottom-24 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-teal-600 text-white shadow-lg shadow-teal-600/30 transition hover:bg-teal-700 active:scale-95 lg:bottom-8 lg:right-8"
      >
        <Plus size={26} strokeWidth={2.4} />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-sm rounded-t-3xl bg-white p-5 shadow-xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">Quick add spend</h3>
              <button onClick={() => setOpen(false)} className="rounded-full p-1 text-slate-400 hover:bg-stone-100"><X size={18} /></button>
            </div>
            <div className="relative mb-4">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl font-semibold text-slate-400">£</span>
              <input
                autoFocus type="number" inputMode="decimal" placeholder="0.00"
                value={amount} onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") save(); }}
                className="w-full rounded-2xl border border-stone-200 bg-stone-50 py-3 pl-10 pr-4 text-2xl font-bold tabular-nums text-slate-900 outline-none focus:border-teal-500"
              />
            </div>
            <p className="mb-1.5 text-xs font-medium text-slate-500">Category</p>
            <div className="mb-4 flex flex-wrap gap-2">
              {cats.map((c) => (
                <button key={c} onClick={() => setCategory(c)}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${category === c ? "bg-teal-600 text-white" : "bg-stone-100 text-slate-600 hover:bg-stone-200"}`}>
                  {c}
                </button>
              ))}
            </div>
            {sources.length > 1 && (
              <div className="mb-4">
                <p className="mb-1.5 text-xs font-medium text-slate-500">Paid with</p>
                <select className={inputCls} value={srcVal} onChange={(e) => setSrcVal(e.target.value)}>
                  {sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            )}
            <button onClick={save} className={`${btnPrimary} w-full`}>
              <Check size={16} /> Add {amount ? gbp(parseFloat(amount) || 0) : "spend"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function MoneyApp({ data, setData, loading, householdCode, onSignOut }) {
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem("mr_tab") || "home"; } catch { return "home"; }
  });
  useEffect(() => {
    try { localStorage.setItem("mr_tab", tab); } catch {}
  }, [tab]);
  const businessOn = data.businessEnabled !== false;

  const acctById = useMemo(() => {
    const m = {};
    data.accounts.forEach((a) => (m[a.id] = a));
    return m;
  }, [data.accounts]);

  /* ---- personal money ---- */
  const billsTotal = useMemo(() => data.bills.reduce((s, b) => s + (b.amount || 0), 0), [data.bills]);
  const loansMonthly = useMemo(() => data.loans.filter((l) => !(l.billId && data.bills.some((b) => b.id === l.billId))).reduce((s, l) => s + (l.monthly || 0), 0), [data.loans, data.bills]);
  const spentThisMonth = useMemo(
    () => data.transactions.filter((t) => isThisMonth(t.date)).reduce((s, t) => s + (t.amount || 0), 0),
    [data.transactions]
  );
  const thisMK = monthKey();
  const balancesTotal = useMemo(() => data.accounts.filter((a) => !a.isTax).reduce((s, a) => s + balanceOf(a), 0), [data.accounts]);
  const personalTaxAside = useMemo(() => data.accounts.filter((a) => a.isTax).reduce((s, a) => s + balanceOf(a), 0), [data.accounts]);
  const bizAccountsList = useMemo(() => (data.business?.accounts || []), [data.business]);
  const bizAvailable = useMemo(() => bizAccountsList.filter((a) => !a.isTax).reduce((s, a) => s + balanceOf(a), 0), [bizAccountsList]);
  const bizTaxAside = useMemo(() => bizAccountsList.filter((a) => a.isTax).reduce((s, a) => s + balanceOf(a), 0), [bizAccountsList]);
  const bizBillsRemaining = useMemo(() => (data.business?.bills || []).filter((b) => dateInThisMonth(nextDue(b.day)) && b.paidMonth !== thisMK).reduce((s, b) => s + (b.amount || 0), 0), [data.business, thisMK]);
  const bizLoansRemaining = useMemo(() => (data.business?.loans || []).filter((l) => (l.monthly || 0) > 0 && !l.payments.some((p) => isThisMonth(p.date)) && !(l.billId && (data.business?.bills || []).some((b) => b.id === l.billId))).reduce((s, l) => s + (l.monthly || 0), 0), [data.business]);
  const bizOutgoings = bizBillsRemaining + bizLoansRemaining;
  const bizSafe = bizAvailable - bizOutgoings;
  const bizStsBreakdown = useMemo(() => ({
    balances: bizAvailable,
    bills: (data.business?.bills || []).filter((b) => dateInThisMonth(nextDue(b.day)) && b.paidMonth !== thisMK).map((b) => ({ name: b.name, amount: b.amount || 0 })),
    loans: (data.business?.loans || []).filter((l) => (l.monthly || 0) > 0 && !l.payments.some((p) => isThisMonth(p.date)) && !(l.billId && (data.business?.bills || []).some((bb) => bb.id === l.billId))).map((l) => ({ name: l.name, amount: l.monthly || 0 })),
    pots: [],
    safe: bizSafe,
  }), [bizAvailable, data.business, bizSafe, thisMK]);
  const totalOverdraft = useMemo(() => data.accounts.filter((a) => !a.isTax).reduce((s, a) => s + (Number(a.overdraft) || 0), 0), [data.accounts]);
  const bizOverdraft = useMemo(() => bizAccountsList.filter((a) => !a.isTax).reduce((s, a) => s + (Number(a.overdraft) || 0), 0), [bizAccountsList]);
  const hasBalances = useMemo(
    () => data.accounts.some((a) => Number.isFinite(a.balance) && a.balance !== 0),
    [data.accounts]
  );
  const remainingBills = useMemo(
    () => data.bills.filter((b) => dateInThisMonth(nextDue(b.day)) && b.paidMonth !== thisMK).reduce((s, b) => s + (b.amount || 0), 0),
    [data.bills, thisMK]
  );
  const remainingLoans = useMemo(
    () =>
      data.loans
        .filter((l) => (l.monthly || 0) > 0 && !l.payments.some((p) => isThisMonth(p.date)) && !(l.billId && data.bills.some((b) => b.id === l.billId)))
        .reduce((s, l) => s + (l.monthly || 0), 0),
    [data.loans, data.bills]
  );
  const earmarked = useMemo(() => (data.pots || []).reduce((s, p) => s + (p.saved || 0), 0), [data.pots]);
  const remainingThisMonth = remainingBills + remainingLoans;
  const safeToSpend = balancesTotal - remainingThisMonth - earmarked;
  const stsBreakdown = useMemo(() => ({
    balances: balancesTotal,
    bills: data.bills.filter((b) => dateInThisMonth(nextDue(b.day)) && b.paidMonth !== thisMK).map((b) => ({ name: b.name, amount: b.amount || 0 })),
    loans: data.loans.filter((l) => (l.monthly || 0) > 0 && !l.payments.some((p) => isThisMonth(p.date)) && !(l.billId && data.bills.some((bb) => bb.id === l.billId))).map((l) => ({ name: l.name, amount: l.monthly || 0 })),
    pots: (data.pots || []).filter((p) => (p.saved || 0) > 0).map((p) => ({ name: p.name, amount: p.saved || 0 })),
    safe: safeToSpend,
  }), [balancesTotal, data.bills, data.loans, data.pots, safeToSpend, thisMK]);
  const committedMonthly = billsTotal + loansMonthly;

  const reserve = Number.isFinite(data.reserve) ? data.reserve : 0;
  const projected = safeToSpend; /* balance after this month's remaining outgoings */
  const shortfall = reserve - projected; /* >0 means below reserve */
  const projection = useMemo(
    () => buildProjection(balancesTotal, data.bills, 42),
    [balancesTotal, data.bills]
  );

  /* ---- draws ---- */
  const monthDraws = useMemo(
    () => data.draws.filter((dr) => isThisMonth(dr.date)).sort((a, b) => (a.date < b.date ? 1 : -1)),
    [data.draws]
  );
  const drawnThisMonth = useMemo(() => monthDraws.reduce((s, d) => s + (d.amount || 0), 0), [monthDraws]);
  const drawnThisYear = useMemo(
    () => data.draws.filter((dr) => isThisYear(dr.date)).reduce((s, d) => s + (d.amount || 0), 0),
    [data.draws]
  );
  const drawnTaxYear = useMemo(() => {
    const now = new Date();
    const startYear = (now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6)) ? now.getFullYear() : now.getFullYear() - 1;
    const start = new Date(startYear, 3, 6);
    return data.draws
      .filter((dr) => dr.date && new Date(dr.date + "T00:00:00") >= start)
      .reduce((s, d) => s + (d.amount || 0), 0);
  }, [data.draws]);
  const drawsByType = useMemo(() => {
    const m = {};
    monthDraws.forEach((d) => (m[d.type] = (m[d.type] || 0) + d.amount));
    return Object.entries(m)
      .map(([type, amount]) => ({ type, amount, color: DRAW_TYPE_COLOURS[type] || "#94a3b8" }))
      .sort((a, b) => b.amount - a.amount);
  }, [monthDraws]);

  const upcoming = useMemo(
    () =>
      data.bills
        .map((b) => ({ ...b, due: nextDue(b.day), n: daysUntil(nextDue(b.day)) }))
        .filter((b) => b.n <= 14)
        .sort((a, b) => a.n - b.n),
    [data.bills]
  );
  const perAccount = useMemo(
    () =>
      data.accounts.map((a) => {
        const bills = data.bills.filter((b) => b.accountId === a.id).reduce((s, b) => s + (b.amount || 0), 0);
        const loans = data.loans.filter((l) => l.accountId === a.id).reduce((s, l) => s + (l.monthly || 0), 0);
        return { ...a, balance: balanceOf(a), total: bills + loans };
      }),
    [data.accounts, data.bills, data.loans]
  );

  const patch = (fn) => setData((d) => fn(structuredClone(d)));
  const resetAll = () => { setData(EMPTY); setTab("home"); };
  const loadExample = () => { setData(makeExample()); setTab("home"); };
  const restoreData = (obj) => { setData(normalizeData(obj)); setTab("home"); };

  const nudges = useMemo(() => buildNudges(data), [data]);
  const addPot = (pot) => patch((d) => { if (!d.pots) d.pots = []; d.pots.push(pot); return d; });
  const delPot = (id) => patch((d) => { d.pots = (d.pots || []).filter((p) => p.id !== id); return d; });
  const movePot = (id, delta) => patch((d) => {
    const p = (d.pots || []).find((x) => x.id === id);
    if (!p) return d;
    // never take out more than is in the pot
    const applied = delta < 0 ? -Math.min(-delta, p.saved || 0) : delta;
    const held = (d.accounts || []).find((a) => a.id === p.accountId);
    const from = (d.accounts || []).find((a) => a.id === p.fromAccountId);
    if (held && from && held.id !== from.id) {
      held.balance = (Number.isFinite(held.balance) ? held.balance : 0) + applied;
      from.balance = (Number.isFinite(from.balance) ? from.balance : 0) - applied;
    }
    p.saved = Math.max(0, (p.saved || 0) + applied);
    return d;
  });
  const editPot = (id, changes) => patch((d) => {
    const p = (d.pots || []).find((x) => x.id === id);
    if (!p) return d;
    Object.assign(p, changes); // relinks/renames only — never touches saved or moves money
    return d;
  });

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-50 text-slate-400">
        Loading your money…
      </div>
    );
  }

  const hasData = data.accounts.length > 0;
  const firstRun = !hasData;

  return (
    <div className="min-h-screen bg-stone-50 text-slate-800">
      <div className="mx-auto flex w-full max-w-7xl">
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-stone-200 bg-white/50 px-3 py-6 lg:flex">
          <div className="mb-6 flex items-center gap-2 px-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-600 text-white">
              <Wallet size={18} />
            </div>
            <span className="text-base font-bold tracking-tight text-slate-800">The Money Room</span>
          </div>
          <nav className="flex flex-col gap-1">
            {NAV.filter((t) => businessOn || t.id !== "income").map((t) => {
              const Active = tab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                    Active ? "bg-teal-50 text-teal-700" : "text-slate-500 hover:bg-stone-100 hover:text-slate-700"
                  }`}
                >
                  <Icon size={19} strokeWidth={Active ? 2.4 : 1.8} />
                  {t.label}
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="mx-auto w-full max-w-md px-4 pb-28 pt-6 lg:mx-0 lg:max-w-none lg:flex-1 lg:px-8 lg:pb-12">
        <header className="mb-5 flex items-center justify-between">
          <div>
            <Eyebrow>Money, made glanceable</Eyebrow>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">The Money Room</h1>
          </div>
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-teal-600 text-white">
            <Wallet size={22} />
          </div>
        </header>

        {!hasData && tab !== "setup" ? (
          <FirstRun onSetup={() => setTab("setup")} onExample={loadExample} />
        ) : (
          <>
            {tab === "home" && (
              <Home
                safeToSpend={safeToSpend}
                breakdown={stsBreakdown}
                balancesTotal={balancesTotal}
                personalTaxAside={personalTaxAside}
                bizAvailable={bizAvailable}
                bizSafe={bizSafe}
                bizOutgoings={bizOutgoings}
                bizBreakdown={bizStsBreakdown}
                bizTaxAside={bizTaxAside}
                bizAccountsList={bizAccountsList}
                totalOverdraft={totalOverdraft}
                bizOverdraft={bizOverdraft}
                remainingThisMonth={remainingThisMonth}
                earmarked={earmarked}
                hasBalances={hasBalances}
                reserve={reserve}
                projection={projection}
                projected={projected}
                shortfall={shortfall}
                nudges={nudges}
                pots={data.pots || []}
                accounts={data.accounts || []}
                onAddPot={addPot}
                onDeletePot={delPot}
                onMovePot={movePot}
                onEditPot={editPot}
                drawnThisMonth={drawnThisMonth}
                drawnTaxYear={drawnTaxYear}
                drawsByType={drawsByType}
                committedMonthly={committedMonthly}
                billsTotal={billsTotal}
                loansMonthly={loansMonthly}
                upcoming={upcoming}
                perAccount={perAccount}
                acctById={acctById}
                onGoSetup={() => setTab("setup")}
                onGoIncome={() => setTab("income")}
                businessOn={businessOn}
              />
            )}
            {tab === "income" && businessOn && (
              <Income
                data={data}
                acctById={acctById}
                monthDraws={monthDraws}
                drawnThisMonth={drawnThisMonth}
                drawnThisYear={drawnThisYear}
                drawsByType={drawsByType}
                committedMonthly={committedMonthly}
                patch={patch}
              />
            )}
            {tab === "bills" && (
              <Bills data={data} acctById={acctById} billsTotal={billsTotal} patch={patch} />
            )}
            {tab === "spend" && (
              <Spend data={data} acctById={acctById} spentThisMonth={spentThisMonth} patch={patch} />
            )}
            {tab === "loans" && (
              <LoansTab data={data} drawnThisMonth={drawnThisMonth} patch={patch} />
            )}
            {tab === "setup" && (
              <Setup data={data} patch={patch} onReset={resetAll} onExample={loadExample} onRestore={restoreData}
                householdCode={householdCode} onSignOut={onSignOut} />
            )}
          </>
        )}
        </div>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white lg:hidden">
        <div className="mx-auto flex max-w-md items-stretch justify-between px-1">
          {NAV.filter((t) => businessOn || t.id !== "income").map((t) => {
            const Active = tab === t.id;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 font-medium transition ${
                  Active ? "text-teal-700" : "text-slate-400 hover:text-slate-600"
                }`}
                style={{ fontSize: "10.5px" }}
              >
                <Icon size={19} strokeWidth={Active ? 2.4 : 1.8} />
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      {!firstRun && <QuickAdd data={data} patch={patch} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  First run                                                          */
/* ------------------------------------------------------------------ */

function FirstRun({ onSetup, onExample }) {
  return (
    <Card className="text-center">
      <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-50 text-teal-600">
        <Sparkles size={26} />
      </div>
      <h2 className="text-lg font-bold text-slate-900">Let's get you set up</h2>
      <p className="mx-auto mt-1 max-w-xs text-sm text-slate-500">
        Add your accounts and their current balances, then drop in your regular
        bills. No need to guess a monthly wage — you'll log money as you take it.
      </p>
      <div className="mt-5 flex flex-col gap-2">
        <button onClick={onSetup} className={btnPrimary}>
          <Plus size={16} /> Set up my accounts
        </button>
        <button onClick={onExample} className={btnGhost}>
          Have a look with example data first
        </button>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  HOME                                                               */
/* ------------------------------------------------------------------ */

function StsBreakdownCard({ breakdown, accountsLabel = "In your spendable accounts" }) {
  const bills = breakdown.bills || [];
  const loans = breakdown.loans || [];
  const pots = breakdown.pots || [];
  return (
    <Card>
      <Eyebrow>How "safe to spend" is worked out</Eyebrow>
      <div className="mt-2.5 space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-slate-600">{accountsLabel}</span>
          <span className="shrink-0 font-semibold tabular-nums text-slate-900">{gbp(breakdown.balances)}</span>
        </div>
        {bills.map((b, i) => (
          <div key={"b" + i} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-slate-500">{b.name} <span className="text-slate-400">· bill this month</span></span>
            <span className="shrink-0 tabular-nums text-rose-600">−{gbp(b.amount)}</span>
          </div>
        ))}
        {loans.map((l, i) => (
          <div key={"l" + i} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-slate-500">{l.name} <span className="text-slate-400">· loan payment this month</span></span>
            <span className="shrink-0 tabular-nums text-rose-600">−{gbp(l.amount)}</span>
          </div>
        ))}
        {pots.map((p, i) => (
          <div key={"p" + i} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-slate-500">{p.name} <span className="text-slate-400">· set aside in a pot</span></span>
            <span className="shrink-0 tabular-nums text-rose-600">−{gbp(p.amount)}</span>
          </div>
        ))}
        {bills.length === 0 && loans.length === 0 && pots.length === 0 && (
          <p className="text-xs text-slate-400">Nothing's being held back — your safe-to-spend is simply what's in your accounts.</p>
        )}
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-stone-100 pt-2 font-bold">
          <span className="text-slate-800">Safe to spend</span>
          <span className="shrink-0 tabular-nums text-slate-900">{gbp(breakdown.safe)}</span>
        </div>
      </div>
    </Card>
  );
}

function Home({
  safeToSpend, balancesTotal, remainingThisMonth, earmarked, hasBalances, breakdown,
  personalTaxAside = 0, bizAvailable = 0, bizSafe = 0, bizOutgoings = 0, bizBreakdown = null, bizTaxAside = 0, bizAccountsList = [], totalOverdraft = 0, bizOverdraft = 0,
  reserve, projection, projected, shortfall, nudges, pots, accounts, onAddPot, onDeletePot, onMovePot, onEditPot,
  drawnThisMonth, drawnTaxYear, drawsByType, committedMonthly, billsTotal, loansMonthly,
  upcoming, perAccount, acctById, onGoSetup, onGoIncome, businessOn,
}) {
  const monthName = new Date().toLocaleDateString("en-GB", { month: "long" });
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showBizBreakdown, setShowBizBreakdown] = useState(false);
  const positive = safeToSpend >= 0;
  const stillToGo = upcoming.reduce((s, b) => s + (b.amount || 0), 0);
  const hasReserve = reserve > 0;
  const needDraw = shortfall > 0;

  return (
    <div className="space-y-4 lg:columns-2 lg:gap-5 lg:space-y-0 lg:[&>*]:mb-5 lg:[&>*]:break-inside-avoid">
      {/* Hero — balance-based */}
      <div
        className={`rounded-3xl p-6 text-white shadow-sm ${
          !hasBalances ? "bg-slate-700" : positive ? "bg-teal-600" : "bg-rose-600"
        }`}
      >
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.72)" }}>
          Safe to spend · {monthName}
        </p>
        {!hasBalances ? (
          <>
            <p className="mt-2 text-2xl font-bold tracking-tight">Add your balances</p>
            <button
              onClick={onGoSetup}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium"
              style={{ backgroundColor: "rgba(255,255,255,0.18)" }}
            >
              Enter what's in your accounts →
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setShowBreakdown((v) => !v)} className="mt-1 block text-left">
              <span className="text-5xl font-bold tabular-nums tracking-tight">{gbp(safeToSpend)}</span>
              <span className="ml-2 align-middle text-xs underline decoration-white/40 underline-offset-2" style={{ color: "rgba(255,255,255,0.75)" }}>
                {showBreakdown ? "hide" : "how's this worked out?"}
              </span>
            </button>
            <p className="mt-3 text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.85)" }}>
              {gbp0(balancesTotal)} in your accounts, minus {gbp0(remainingThisMonth)} still
              to leave this month{earmarked > 0 ? `, minus ${gbp0(earmarked)} you've set aside` : ""}.
            </p>
            {personalTaxAside > 0 && (
              <p className="mt-2 text-xs" style={{ color: "rgba(255,255,255,0.7)" }}>
                Plus {gbp0(personalTaxAside)} held for VAT/tax — kept out of this number.
              </p>
            )}
            {totalOverdraft > 0 && (
              <p className="mt-1 text-xs" style={{ color: "rgba(255,255,255,0.7)" }}>
                Plus {gbp0(totalOverdraft)} overdraft available if you need it.
              </p>
            )}
          </>
        )}
      </div>

      {showBreakdown && breakdown && <StsBreakdownCard breakdown={breakdown} />}

      {businessOn && bizAccountsList.length > 0 && (
        <Card>
          <div className="flex items-center gap-2">
            <Briefcase size={15} className="text-teal-600" />
            <Eyebrow>Business — safe to spend</Eyebrow>
          </div>
          <button onClick={() => setShowBizBreakdown((v) => !v)} className="mt-2 block text-left">
            <span className={`text-4xl font-bold tabular-nums tracking-tight ${bizSafe >= 0 ? "text-slate-900" : "text-rose-600"}`}>{gbp(bizSafe)}</span>
            <span className="ml-2 align-middle text-xs text-slate-400 underline decoration-slate-300 underline-offset-2">
              {showBizBreakdown ? "hide" : "how's this worked out?"}
            </span>
          </button>
          <p className="mt-1 text-sm text-slate-500">
            {gbp0(bizAvailable)} in the business{bizOutgoings > 0 ? `, minus ${gbp0(bizOutgoings)} of bills & loans still to leave this month` : ""}.
          </p>
          {bizTaxAside > 0 && (
            <p className="mt-1 text-xs text-slate-400">
              Plus {gbp0(bizTaxAside)} held for VAT/tax — kept aside.
            </p>
          )}
          {bizOverdraft > 0 && (
            <p className="mt-1 text-xs text-slate-400">
              Plus {gbp0(bizOverdraft)} overdraft available if needed.
            </p>
          )}
        </Card>
      )}

      {businessOn && bizAccountsList.length > 0 && showBizBreakdown && bizBreakdown && (
        <StsBreakdownCard breakdown={bizBreakdown} accountsLabel="In the business accounts" />
      )}

      {/* The month ahead — forward projection */}
      {hasBalances && projection && projection.points.some((p) => p.drop > 0) && (
        <Card>
          <div className="flex items-baseline justify-between">
            <Eyebrow>The month ahead</Eyebrow>
            <span className="text-xs text-slate-400">next 6 weeks</span>
          </div>
          <p className="mb-3 mt-1 text-sm text-slate-500">
            Your balance as upcoming bills come off — so you can see the dips before they land.
          </p>
          <div className="h-40 w-full">
            <ResponsiveContainer>
              <AreaChart data={projection.points} margin={{ top: 6, right: 8, bottom: 0, left: 8 }}>
                <defs>
                  <linearGradient id="projFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0d9488" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="#0d9488" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false}
                  axisLine={false} interval="preserveStartEnd" minTickGap={30} />
                <YAxis hide domain={[(dMin) => Math.min(dMin, reserve > 0 ? reserve : dMin), "dataMax"]} />
                <Tooltip formatter={(v) => [gbp(v), "Balance"]} />
                {reserve > 0 && <ReferenceLine y={reserve} stroke="#f59e0b" strokeDasharray="4 4" strokeWidth={1.5} />}
                <Area type="monotone" dataKey="balance" stroke="#0d9488" strokeWidth={2.5} fill="url(#projFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {(() => {
            const low = projection.low;
            const belowReserve = reserve > 0 && low < reserve;
            const tone = low < 0 ? "rose" : belowReserve ? "amber" : "teal";
            const cls = tone === "rose" ? "bg-rose-50 text-rose-700"
              : tone === "amber" ? "bg-amber-50 text-amber-800" : "bg-teal-50 text-teal-800";
            const when = projection.lowOff === 0
              ? "right now"
              : `around ${projection.lowDate.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`;
            return (
              <div className={`mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm ${cls}`}>
                {tone === "teal" ? <Check size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
                <span>
                  Lowest point: <span className="font-semibold tabular-nums">{gbp(low)}</span> {when}
                  {reserve > 0 && (belowReserve
                    ? ` — ${gbp0(reserve - low)} under your ${gbp0(reserve)} safety net.`
                    : ` — comfortably above your ${gbp0(reserve)} safety net.`)}
                  {reserve <= 0 && "."}
                </span>
              </div>
            );
          })()}
        </Card>
      )}

      {/* Needs you — auto nudges */}
      {hasBalances && (
        nudges.length > 0 ? (
          <Card>
            <Eyebrow>Needs you</Eyebrow>
            <ul className="mt-3 space-y-2">
              {nudges.map((n) => {
                const tone =
                  n.tone === "warn"
                    ? { box: "border-amber-200 bg-amber-50", ic: "text-amber-600" }
                    : n.tone === "good"
                    ? { box: "border-teal-200 bg-teal-50", ic: "text-teal-600" }
                    : { box: "border-stone-200 bg-stone-50", ic: "text-slate-400" };
                return (
                  <li key={n.id} className={`flex gap-2.5 rounded-xl border px-3 py-2.5 ${tone.box}`}>
                    <span className={`mt-0.5 shrink-0 ${tone.ic}`}>
                      {n.tone === "good" ? <Check size={16} strokeWidth={3} /> : <AlertTriangle size={16} />}
                    </span>
                    <span className="text-sm leading-snug text-slate-700">{n.text}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : (
          <Card>
            <p className="flex items-center gap-2 py-1 text-sm text-slate-500">
              <Check size={16} strokeWidth={3} className="text-teal-600" />
              All calm — nothing needs you right now. Nice.
            </p>
          </Card>
        )
      )}

      {/* Do you need to draw more? */}
      {businessOn && hasBalances && (
        <div
          className={`rounded-3xl border p-5 shadow-sm ${
            needDraw ? "border-amber-200 bg-amber-50" : "border-teal-200 bg-teal-50"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={needDraw ? "text-amber-600" : "text-teal-600"}>
              {needDraw ? <AlertTriangle size={18} /> : <Check size={18} strokeWidth={3} />}
            </span>
            <Eyebrow>Do you need to draw more?</Eyebrow>
          </div>

          {needDraw ? (
            <>
              <p className="mt-2 text-3xl font-bold tabular-nums text-amber-900">
                Yes — about {gbp0(shortfall)}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-amber-800">
                {hasReserve ? (
                  <>After this month's bills clear you'll be at {gbp(projected)} — that's{" "}
                  {gbp0(shortfall)} below your {gbp0(reserve)} reserve. A draw of around{" "}
                  {gbp0(shortfall)} brings you back up.</>
                ) : (
                  <>After this month's bills clear you'll be at {gbp(projected)}. To stay out of the
                  red you'd need to draw at least {gbp0(shortfall)}.</>
                )}
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-2xl font-bold text-teal-900">You're covered for now</p>
              <p className="mt-1.5 text-sm leading-relaxed text-teal-800">
                {hasReserve ? (
                  <>You'll be at {gbp(projected)} after this month's bills — {gbp0(-shortfall)} above
                  your reserve.</>
                ) : (
                  <>You'll be at {gbp(projected)} after this month's bills. Set a reserve in More for
                  a clearer target.</>
                )}
              </p>
            </>
          )}
          <p className="mt-2 text-xs text-slate-500">
            How you take it — salary, dividend or director's loan — is your call.
          </p>
        </div>
      )}

      {hasBalances && <AffordCheck safeToSpend={safeToSpend} reserve={reserve} />}

      {hasBalances && (
        <PotsCard pots={pots} earmarked={earmarked} drawnTaxYear={drawnTaxYear} accounts={accounts}
          onCreate={onAddPot} onDelete={onDeletePot} onMove={onMovePot} onEdit={onEditPot} />
      )}

      {/* This month's draws */}
      {businessOn && (
      <Card>
        <div className="flex items-start justify-between">
          <div>
            <Eyebrow>Taken from the business · {monthName}</Eyebrow>
            <p className="mt-1 text-3xl font-bold tabular-nums text-slate-900">{gbp(drawnThisMonth)}</p>
          </div>
          <button
            onClick={onGoIncome}
            className="inline-flex items-center gap-1.5 rounded-xl bg-teal-50 px-3 py-2 text-sm font-semibold text-teal-700 transition hover:bg-teal-100"
          >
            <Plus size={15} /> Log a draw
          </button>
        </div>
        {drawsByType.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {drawsByType.map((d) => (
              <span key={d.type} className="flex items-center gap-1.5 text-xs text-slate-500">
                <Dot color={d.color} />
                {d.type.replace(" / ad-hoc", "")} {gbp0(d.amount)}
              </span>
            ))}
          </div>
        )}
        <div className="mt-3 rounded-xl bg-stone-50 px-3 py-2.5 text-sm text-slate-500">
          Your life costs about{" "}
          <span className="font-semibold text-slate-700">{gbp0(committedMonthly)}/mo</span> in
          bills &amp; loans ({gbp0(billsTotal)} + {gbp0(loansMonthly)}).
        </div>
      </Card>
      )}

      {/* Coming out soon */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <Eyebrow>Coming out soon</Eyebrow>
            <p className="text-sm text-slate-500">Next 14 days</p>
          </div>
          {stillToGo > 0 && (
            <div className="text-right">
              <p className="text-xs text-slate-400">Total leaving</p>
              <p className="text-lg font-bold tabular-nums text-slate-900">{gbp(stillToGo)}</p>
            </div>
          )}
        </div>
        {upcoming.length === 0 ? (
          <p className="rounded-xl bg-stone-50 px-4 py-6 text-center text-sm text-slate-400">
            Nothing due in the next two weeks. Nice and quiet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {upcoming.map((b) => {
              const a = acctById[b.accountId];
              const soon = b.n <= 3;
              return (
                <li key={b.id} className="flex items-center justify-between gap-3 rounded-xl border border-stone-100 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-800">{b.name}</p>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
                      {a && <Dot color={a.color} />}
                      <span className="truncate">{a ? a.name : "No account"}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold tabular-nums text-slate-900">{gbp(b.amount)}</p>
                    <p className={`text-xs font-medium ${soon ? "text-rose-500" : "text-slate-400"}`}>
                      {dueLabel(b.n)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Per account */}
      {perAccount.length > 0 && (
        <Card>
          <Eyebrow>Your accounts right now</Eyebrow>
          <ul className="mt-3 space-y-2.5">
            {perAccount.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Dot color={a.color} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-700">{a.name}</p>
                    {a.total > 0 && <p className="text-xs text-slate-400">needs {gbp0(a.total)} this month</p>}
                  </div>
                </div>
                <p className="text-sm font-bold tabular-nums text-slate-900">{gbp(a.balance)}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CAN I AFFORD IT?                                                   */
/* ------------------------------------------------------------------ */

function AffordCheck({ safeToSpend, reserve }) {
  const [amt, setAmt] = useState("");
  const n = parseFloat(amt);
  const has = Number.isFinite(n) && n > 0;
  const after = safeToSpend - (has ? n : 0);
  const hasReserve = reserve > 0;

  const tone = after < 0 ? "rose" : hasReserve && after < reserve ? "amber" : "teal";
  const boxCls =
    tone === "rose" ? "bg-rose-50 text-rose-800" : tone === "amber" ? "bg-amber-50 text-amber-800" : "bg-teal-50 text-teal-800";

  return (
    <Card>
      <Eyebrow>Can I afford it?</Eyebrow>
      <p className="mb-3 mt-1 text-sm text-slate-500">Thinking of buying something? Pop the amount in.</p>
      <div className="flex items-center gap-2">
        <span className="text-lg font-semibold text-slate-400">£</span>
        <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00"
          value={amt} onChange={(e) => setAmt(e.target.value)} />
      </div>
      {has && (
        <div className={`mt-3 rounded-xl px-3 py-2.5 text-sm leading-relaxed ${boxCls}`}>
          {after < 0 ? (
            <>That would leave you {gbp(after)} — past what's free this month. Maybe hold off, or top up first.</>
          ) : hasReserve && after < reserve ? (
            <>You could, but it'd dip you to {gbp(after)} — under your {gbp0(reserve)} reserve.</>
          ) : (
            <>Go for it — you'd still have {gbp(after)} free{hasReserve ? ", comfortably above your reserve" : ""}.</>
          )}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  SINKING FUNDS / POTS                                               */
/* ------------------------------------------------------------------ */

function PotsCard({ pots, earmarked, drawnTaxYear, accounts = [], onCreate, onDelete, onMove, onEdit }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPot, setEditingPot] = useState(null);
  const [kind, setKind] = useState("goal");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [rate, setRate] = useState("");
  const [color, setColor] = useState(ACCOUNT_COLORS[2]);
  const [fromAccountId, setFromAccountId] = useState(accounts[0]?.id || "");
  const [accountId, setAccountId] = useState(accounts[1]?.id || accounts[0]?.id || "");
  const [moveId, setMoveId] = useState(pots[0]?.id || "");
  const [moveAmt, setMoveAmt] = useState("");

  const create = () => {
    const accts = { fromAccountId, accountId };
    if (kind === "tax") {
      const r = parseFloat(rate);
      onCreate({ id: uid(), name: name.trim() || "Tax", saved: 0, color, kind: "tax", rate: Number.isFinite(r) ? r : 20, ...accts });
    } else {
      if (!name.trim()) return;
      const t = parseFloat(target);
      onCreate({ id: uid(), name: name.trim(), saved: 0, color, target: Number.isFinite(t) ? t : 0, targetDate: targetDate || "", ...accts });
    }
    setName(""); setTarget(""); setTargetDate(""); setRate(""); setKind("goal"); setCreateOpen(false);
  };

  const move = (sign) => {
    const a = parseFloat(moveAmt);
    if (!Number.isFinite(a) || a <= 0 || !moveId) return;
    onMove(moveId, sign * a);
    setMoveAmt("");
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <Eyebrow>Set aside · pots</Eyebrow>
        {earmarked > 0 && <p className="text-sm font-bold tabular-nums text-slate-900">{gbp(earmarked)}</p>}
      </div>
      <p className="mb-3 mt-1 text-sm text-slate-500">
        Stash a little for the stuff that always ambushes you — car service, Christmas, insurance.
        It quietly drops out of your safe-to-spend so it's there when you need it.
      </p>

      {pots.length > 0 && (
        <ul className="space-y-3">
          {pots.map((p) => {
            const isTax = p.kind === "tax";
            const saved = p.saved || 0;
            const goal = isTax ? Math.round((drawnTaxYear || 0) * (p.rate || 0) / 100) : (p.target || 0);
            const pct = goal > 0 ? Math.min(100, (saved / goal) * 100) : 0;
            let hint = null;
            if (isTax) {
              const gap = goal - saved;
              hint = `${p.rate || 0}% of the ${gbp0(drawnTaxYear || 0)} drawn this tax year${gap > 0 ? ` · ${gbp0(gap)} still to set aside` : " · covered ✓"}`;
            } else if (p.target > 0 && p.targetDate) {
              const now = new Date(); now.setHours(0, 0, 0, 0);
              const t = new Date(p.targetDate + "T00:00:00");
              const months = Math.max(1, (t.getFullYear() - now.getFullYear()) * 12 + (t.getMonth() - now.getMonth()));
              const remaining = p.target - saved;
              const by = t.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
              hint = remaining <= 0 ? `Fully saved ✓ — ready for ${by}` : `${gbp0(Math.ceil(remaining / months))}/mo to reach it by ${by}`;
            }
            return (
              <li key={p.id}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <Dot color={p.color} /> {p.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm tabular-nums text-slate-500">
                      {gbp0(saved)}{goal > 0 ? ` / ${gbp0(goal)}` : ""}
                    </span>
                    {onEdit && <EditBtn onClick={() => setEditingPot(p)} />}
                    <button onClick={() => onDelete(p.id)} className="text-slate-300 hover:text-rose-500">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                {goal > 0 && (
                  <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-stone-100">
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: p.color }} />
                  </div>
                )}
                {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
                {p.accountId && p.fromAccountId && p.accountId !== p.fromAccountId && (
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {accounts.find((a) => a.id === p.fromAccountId)?.name || "account"} → {accounts.find((a) => a.id === p.accountId)?.name || "account"}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {pots.length > 0 && (
        <div className="mt-4 space-y-2 rounded-2xl bg-stone-50 p-3">
          <span className="block text-xs font-medium text-slate-500">Move money</span>
          <div className="flex gap-2">
            <select className={inputCls} value={moveId} onChange={(e) => setMoveId(e.target.value)}>
              {pots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input className={inputCls} style={{ maxWidth: 110 }} type="number" inputMode="decimal" placeholder="£"
              value={moveAmt} onChange={(e) => setMoveAmt(e.target.value)} />
          </div>
          {(() => {
            const sel = pots.find((p) => p.id === moveId);
            if (sel && sel.accountId && sel.fromAccountId && sel.accountId !== sel.fromAccountId) {
              const fromN = accounts.find((a) => a.id === sel.fromAccountId)?.name || "account";
              const heldN = accounts.find((a) => a.id === sel.accountId)?.name || "account";
              return <p className="text-[11px] text-slate-400">Add: {fromN} → {heldN}. Take out reverses it.</p>;
            }
            return null;
          })()}
          <div className="flex gap-2">
            <button onClick={() => move(1)} className={`${btnPrimary} flex-1`}>
              <Plus size={15} /> Add
            </button>
            <button onClick={() => move(-1)} className={`${btnGhost} flex-1`}>
              Take out
            </button>
          </div>
        </div>
      )}

      {createOpen ? (
        <div className="mt-3 space-y-3 rounded-2xl bg-stone-50 p-3">
          <div className="flex gap-2">
            <button onClick={() => setKind("goal")}
              className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${kind === "goal" ? "bg-teal-600 text-white" : "bg-white text-slate-600"}`}>
              Savings goal
            </button>
            <button onClick={() => setKind("tax")}
              className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${kind === "tax" ? "bg-teal-600 text-white" : "bg-white text-slate-600"}`}>
              Tax pot
            </button>
          </div>
          <Field label="Name">
            <input className={inputCls} placeholder={kind === "tax" ? "e.g. Tax" : "e.g. Christmas"} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {kind === "tax" ? (
            <>
              <Field label="Set aside this % of what you draw">
                <input className={inputCls} type="number" inputMode="decimal" placeholder="20"
                  value={rate} onChange={(e) => setRate(e.target.value)} />
              </Field>
              <p className="text-xs text-slate-400">A rough guide based on your drawings this tax year, not a tax calculation.</p>
            </>
          ) : (
            <>
              <Field label="Target (£) — optional">
                <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00"
                  value={target} onChange={(e) => setTarget(e.target.value)} />
              </Field>
              <Field label="Need it by — optional">
                <input className={inputCls} type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
              </Field>
            </>
          )}
          {accounts.length > 0 && (
            <>
              <Field label="Money comes from">
                <select className={inputCls} value={fromAccountId} onChange={(e) => setFromAccountId(e.target.value)}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="Held in">
                <select className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            </>
          )}
          <div>
            <span className="mb-1.5 block text-xs font-medium text-slate-500">Colour</span>
            <div className="flex flex-wrap gap-2">
              {ACCOUNT_COLORS.map((c) => (
                <button key={c} onClick={() => setColor(c)}
                  className={`h-8 w-8 rounded-full transition ${color === c ? "ring-2 ring-slate-900 ring-offset-2" : ""}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
          <button onClick={create} className={`${btnPrimary} w-full`}>
            <Check size={16} /> Create pot
          </button>
        </div>
      ) : (
        <button onClick={() => setCreateOpen(true)} className={`${btnGhost} mt-3 w-full`}>
          <Plus size={15} /> New pot
        </button>
      )}
      {editingPot && (
        <EditModal
          title={editingPot.kind === "tax" ? "Edit tax pot" : "Edit pot"}
          item={editingPot}
          fields={[
            { key: "name", label: "Name", type: "text" },
            ...(editingPot.kind === "tax"
              ? [{ key: "rate", label: "Tax rate (%)", type: "percent" }]
              : [
                  { key: "target", label: "Target (£)", type: "money" },
                  { key: "targetDate", label: "Need it by (optional)", type: "date" },
                ]),
            ...(accounts.length > 1
              ? [
                  { key: "fromAccountId", label: "Funded from", type: "select", options: accounts.map((a) => ({ value: a.id, label: a.name })) },
                  { key: "accountId", label: "Held in", type: "select", options: accounts.map((a) => ({ value: a.id, label: a.name })) },
                ]
              : []),
          ]}
          onSave={(changes) => { onEdit(editingPot.id, changes); setEditingPot(null); }}
          onClose={() => setEditingPot(null)}
        />
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  INCOME (draws)                                                     */
/* ------------------------------------------------------------------ */

function Income({
  data, acctById, monthDraws, drawnThisMonth, drawnThisYear,
  drawsByType, committedMonthly, patch,
}) {
  const [amount, setAmount] = useState("");
  const [type, setType] = useState(DRAW_TYPES[1]);
  const [accountId, setAccountId] = useState(data.accounts[0]?.id || "");
  const [date, setDate] = useState(localISO());
  const [note, setNote] = useState("");
  const [addToBalance, setAddToBalance] = useState(true);
  const bizAccounts = data.business?.accounts || [];
  const [bizAccountId, setBizAccountId] = useState(bizAccounts[0]?.id || "");
  const [takeFromBiz, setTakeFromBiz] = useState(bizAccounts.length > 0);

  const acctName = acctById[accountId]?.name || "the account";
  const bizName = bizAccounts.find((a) => a.id === bizAccountId)?.name || "the business account";

  const add = () => {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const pullBiz = takeFromBiz && bizAccounts.length > 0 && !!bizAccountId;
    patch((d) => {
      d.draws.push({
        id: uid(), amount: amt, type,
        accountId: accountId || data.accounts[0]?.id || "",
        date: date || localISO(), note: note.trim(), applied: addToBalance,
        bizAccountId: pullBiz ? bizAccountId : "", bizApplied: pullBiz,
      });
      if (addToBalance) {
        const a = d.accounts.find((x) => x.id === accountId);
        if (a) a.balance = balanceOf(a) + amt;
      }
      if (pullBiz) {
        const ba = d.business.accounts.find((x) => x.id === bizAccountId);
        if (ba) ba.balance = balanceOf(ba) - amt;
      }
      return d;
    });
    setAmount(""); setNote("");
  };

  const remove = (dr) => {
    patch((d) => {
      if (dr.applied) {
        const a = d.accounts.find((x) => x.id === dr.accountId);
        if (a) a.balance = balanceOf(a) - dr.amount;
      }
      if (dr.bizApplied && dr.bizAccountId) {
        const ba = d.business.accounts.find((x) => x.id === dr.bizAccountId);
        if (ba) ba.balance = balanceOf(ba) + dr.amount;
      }
      d.draws = d.draws.filter((x) => x.id !== dr.id);
      return d;
    });
  };

  return (
    <div className="space-y-4 lg:columns-2 lg:gap-5 lg:space-y-0 lg:[&>*]:mb-5 lg:[&>*]:break-inside-avoid">
      <div className="rounded-3xl bg-slate-900 p-5 text-white shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.6)" }}>
          Drawn this month
        </p>
        <p className="mt-1 text-4xl font-bold tabular-nums tracking-tight">{gbp(drawnThisMonth)}</p>
        <p className="mt-2 text-sm" style={{ color: "rgba(255,255,255,0.7)" }}>
          {gbp0(drawnThisYear)} so far this year · life costs ~{gbp0(committedMonthly)}/mo
        </p>
      </div>

      <Card>
        <Eyebrow>Log money you've taken</Eyebrow>
        <p className="mb-3 mt-1 text-sm text-slate-500">
          Whenever you move money from the company to yourself, drop it in here.
        </p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount (£)">
              <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00"
                value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Date">
              <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Type">
            <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
              {DRAW_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Into account">
            <select className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Note (optional)">
            <input className={inputCls} placeholder="e.g. covering car repair"
              value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <CheckToggle checked={addToBalance} onChange={setAddToBalance} label={`Add it to ${acctName}'s balance`} />
          {bizAccounts.length > 0 && (
            <>
              <Field label="Out of which business account">
                <select className={inputCls} value={bizAccountId} onChange={(e) => setBizAccountId(e.target.value)}>
                  {bizAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <CheckToggle checked={takeFromBiz} onChange={setTakeFromBiz} label={`Take it out of ${bizName}'s cash`} />
            </>
          )}
          <button onClick={add} className={`${btnPrimary} w-full`}>
            <Plus size={16} /> Log draw
          </button>
        </div>
      </Card>

      {drawsByType.length > 0 && (
        <Card>
          <Eyebrow>How you've paid yourself · this month</Eyebrow>
          <ul className="mt-3 space-y-2">
            {drawsByType.map((d) => (
              <li key={d.type} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-slate-600">
                  <Dot color={d.color} /> {d.type}
                </span>
                <span className="font-semibold tabular-nums text-slate-900">{gbp(d.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-800">
            Keeping salary, dividends and ad-hoc draws split out makes life easier
            at year-end — it's the split your accountant works from.
          </p>
        </Card>
      )}

      <Card>
        <Eyebrow>Recent draws</Eyebrow>
        {monthDraws.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">Nothing logged this month yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-stone-100">
            {monthDraws.slice(0, 30).map((dr) => {
              const a = acctById[dr.accountId];
              return (
                <li key={dr.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{dr.note || dr.type}</p>
                    <p className="text-xs text-slate-400">
                      {dr.type} ·{" "}
                      {new Date(dr.date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                      {a ? ` · ${a.name}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold tabular-nums text-teal-700">+{gbp(dr.amount)}</span>
                    <button onClick={() => remove(dr)} className="text-slate-300 hover:text-rose-500">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BILLS                                                              */
/* ------------------------------------------------------------------ */

// A simple month grid showing which days bills land on, with the day's total.
function BillCalendar({ bills }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const y = today.getFullYear();
  const m = today.getMonth();
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const startWeekday = (first.getDay() + 6) % 7; // Monday-first
  const byDay = {};
  (bills || []).forEach((b) => {
    const d = Number(b.day) || 0;
    const amt = Number(b.amount) || 0;
    if (!d || !amt) return;
    const dd = Math.min(d, daysInMonth);
    byDay[dd] = (byDay[dd] || 0) + amt;
  });
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const monthLabel = first.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const monthTotal = Object.values(byDay).reduce((s, v) => s + v, 0);
  const weekdays = ["M", "T", "W", "T", "F", "S", "S"];
  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <Eyebrow>Bill calendar</Eyebrow>
        <span className="text-xs text-slate-400">{monthLabel}</span>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-1 text-center">
        {weekdays.map((w, i) => (
          <div key={`h${i}`} className="pb-1 text-[10px] font-semibold uppercase text-slate-400">{w}</div>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <div key={i} />;
          const amt = byDay[d];
          const isToday = d === today.getDate();
          const isPast = d < today.getDate();
          return (
            <div
              key={i}
              className={`flex min-h-[40px] flex-col items-center justify-start rounded-lg px-0.5 py-1 ${amt ? (isPast ? "bg-stone-100" : "bg-teal-50") : ""} ${isToday ? "ring-1 ring-teal-500" : ""}`}
            >
              <span className={`text-xs ${isToday ? "font-bold text-teal-700" : isPast ? "text-slate-400" : "text-slate-600"}`}>{d}</span>
              {amt ? (
                <span className={`mt-0.5 text-[9px] font-semibold leading-none ${isPast ? "text-slate-400" : "text-teal-700"}`}>{gbp0(amt)}</span>
              ) : null}
            </div>
          );
        })}
      </div>
      {monthTotal > 0 && (
        <p className="mt-3 text-center text-xs text-slate-400">
          {gbp0(monthTotal)} of bills across {first.toLocaleDateString("en-GB", { month: "long" })}
        </p>
      )}
    </Card>
  );
}

function BillsPane({ bills, accounts, patch, scope }) {
  const isBiz = scope === "business";
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState("1");
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [editing, setEditing] = useState(null);
  const thisMK = monthKey();
  const acctById = Object.fromEntries(accounts.map((a) => [a.id, a]));

  const getArr = (d) => {
    if (isBiz) { if (!d.business.bills) d.business.bills = []; return d.business.bills; }
    return d.bills;
  };

  const add = () => {
    const amt = parseFloat(amount);
    if (!name.trim() || !Number.isFinite(amt)) return;
    patch((d) => {
      getArr(d).push({
        id: uid(), name: name.trim(), amount: amt,
        day: Math.min(31, Math.max(1, parseInt(day) || 1)),
        accountId: accountId || accounts[0]?.id || "", paidMonth: "",
      });
      return d;
    });
    setName(""); setAmount(""); setDay("1"); setOpen(false);
  };

  const sorted = [...bills].sort((a, b) => a.day - b.day);
  const total = bills.reduce((s, b) => s + (b.amount || 0), 0);
  const togglePaid = (b) =>
    patch((d) => {
      const x = getArr(d).find((y) => y.id === b.id);
      if (x) x.paidMonth = x.paidMonth === thisMK ? "" : thisMK;
      return d;
    });
  const del = (id) =>
    patch((d) => { const arr = getArr(d); const i = arr.findIndex((x) => x.id === id); if (i >= 0) arr.splice(i, 1); return d; });
  const paidCount = sorted.filter((b) => b.paidMonth === thisMK).length;

  return (
    <div className="space-y-4 lg:columns-2 lg:gap-5 lg:space-y-0 lg:[&>*]:mb-5 lg:[&>*]:break-inside-avoid">
      <SummaryBar label={isBiz ? "Business bills, every month" : "Regular bills, every month"} value={total}
        sub={`${bills.length} bill${bills.length === 1 ? "" : "s"}${paidCount > 0 ? ` · ${paidCount} paid this month` : ""}`} />

      {bills.length > 0 && <BillCalendar bills={bills} />}

      {!open ? (
        <button onClick={() => setOpen(true)} className={`${btnPrimary} w-full`}>
          <Plus size={16} /> Add a {isBiz ? "business bill" : "bill"}
        </button>
      ) : (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <Eyebrow>{isBiz ? "New business bill" : "New bill"}</Eyebrow>
            <button onClick={() => setOpen(false)} className="text-slate-400"><X size={18} /></button>
          </div>
          <div className="space-y-3">
            <Field label="What is it?">
              <input className={inputCls} placeholder={isBiz ? "e.g. Software, insurance" : "e.g. Council tax"} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (£)">
                <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00"
                  value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <Field label="Day of month">
                <input className={inputCls} type="number" inputMode="numeric" min="1" max="31"
                  value={day} onChange={(e) => setDay(e.target.value)} />
              </Field>
            </div>
            {accounts.length > 0 && (
              <Field label="Comes out of">
                <select className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            )}
            <button onClick={add} className={`${btnPrimary} w-full`}>
              <Check size={16} /> Save bill
            </button>
          </div>
        </Card>
      )}

      <Card>
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            {isBiz
              ? "No business bills yet. Add the company's regular outgoings — software, insurance, subscriptions, rent."
              : "No bills yet. Add the ones that leave automatically — direct debits, standing orders, subscriptions."}
          </p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {sorted.map((b) => {
              const a = acctById[b.accountId];
              const paid = b.paidMonth === thisMK;
              return (
                <li key={b.id} className={`flex items-center justify-between gap-3 py-3 ${paid ? "opacity-55" : ""}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <button
                      onClick={() => togglePaid(b)}
                      title={paid ? "Paid this month — tap to undo" : "Mark paid this month"}
                      aria-label={paid ? "Mark unpaid" : "Mark paid"}
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition ${paid ? "border-teal-600 bg-teal-600 text-white" : "border-stone-300 text-transparent hover:border-teal-400"}`}
                    >
                      <Check size={14} />
                    </button>
                    <div className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl bg-stone-100">
                      <span className="text-sm font-bold leading-none text-slate-700">{b.day}</span>
                      <span className="uppercase text-slate-400" style={{ fontSize: "9px", lineHeight: 1.4 }}>day</span>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-800">{b.name}</p>
                      <div className="flex items-center gap-1.5 text-xs text-slate-400">
                        {paid ? (
                          <span className="font-medium text-teal-600">Paid this month</span>
                        ) : (
                          <>
                            {a && <Dot color={a.color} />}
                            <span className="truncate">{a ? a.name : "—"}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold tabular-nums text-slate-900">{gbp(b.amount)}</span>
                    <EditBtn onClick={() => setEditing(b)} />
                    <button
                      onClick={() => del(b.id)}
                      className="text-slate-300 hover:text-rose-500"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {editing && (
        <EditModal
          title={isBiz ? "Edit business bill" : "Edit bill"}
          item={editing}
          fields={[
            { key: "name", label: "What is it?", type: "text" },
            { key: "amount", label: "Amount (£)", type: "money" },
            { key: "day", label: "Day of month", type: "number" },
            ...(accounts.length > 0 ? [{ key: "accountId", label: "Comes out of", type: "select", options: accounts.map((a) => ({ value: a.id, label: a.name })) }] : []),
          ]}
          onClose={() => setEditing(null)}
          onSave={(vals) => {
            patch((d) => {
              const b = getArr(d).find((x) => x.id === editing.id);
              if (b) { b.name = vals.name; b.amount = vals.amount; b.day = Math.min(31, Math.max(1, vals.day || 1)); b.accountId = vals.accountId; }
              return d;
            });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Bills({ data, patch }) {
  const businessOn = data.businessEnabled !== false;
  const [seg, setSeg] = useState("personal");
  const showBiz = businessOn && seg === "business";
  return (
    <div className="space-y-4">
      {businessOn && (
        <div className="flex rounded-2xl bg-stone-100 p-1">
          <button
            onClick={() => setSeg("personal")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-semibold transition ${seg === "personal" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
          >
            <Wallet size={15} /> Personal
          </button>
          <button
            onClick={() => setSeg("business")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-semibold transition ${seg === "business" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
          >
            <Briefcase size={15} /> Business
          </button>
        </div>
      )}
      {showBiz ? (
        <BillsPane bills={data.business?.bills || []} accounts={data.business?.accounts || []} patch={patch} scope="business" />
      ) : (
        <BillsPane bills={data.bills} accounts={data.accounts} patch={patch} scope="personal" />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  STATEMENT ANALYSER (Claude API)                                   */
/* ------------------------------------------------------------------ */

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function StatementAnalyser({ data, patch }) {
  // Remember the last analysis so it survives the phone reloading the page in the background.
  const [saved] = useState(() => {
    try { return JSON.parse(localStorage.getItem("mr_analysis") || "null"); } catch { return null; }
  });
  const [open, setOpen] = useState(!!(saved && saved.result));
  const [text, setText] = useState("");
  const [pdfBase64, setPdfBase64] = useState("");
  const [fileName, setFileName] = useState(saved?.fileName || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(saved?.result || null);
  const [imported, setImported] = useState(saved?.imported || false);
  const [addedKeys, setAddedKeys] = useState(saved?.addedKeys || []);
  const [extracting, setExtracting] = useState(false);
  const [expandedCat, setExpandedCat] = useState(null);
  const [billTarget, setBillTarget] = useState("");

  // Keep that saved copy in sync, and clear it when the analysis is cleared.
  useEffect(() => {
    try {
      if (result) localStorage.setItem("mr_analysis", JSON.stringify({ result, fileName, imported, addedKeys }));
      else localStorage.removeItem("mr_analysis");
    } catch {}
  }, [result, fileName, imported, addedKeys]);

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setFileName(f.name); setError(null); setResult(null); setImported(false); setAddedKeys([]);
    const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setText(await f.text()); setPdfBase64("");
      return;
    }
    // PDF: pull the text out here, then send it as text (the path that works).
    setExtracting(true);
    try {
      const buf = await f.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      let out = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        out += tc.items.map((it) => it.str).join(" ") + "\n";
        if (out.length > 40000) break;
      }
      if (out.trim().length > 40) {
        setText(out); setPdfBase64("");
      } else {
        // No text layer (e.g. a scan) — sending the whole file just times out,
        // so point at the routes that do work instead.
        setError("This PDF has no readable text in it (it may be a scan). Your bank's CSV export, or pasting the transactions in, will work.");
        setFileName("");
      }
    } catch (err) {
      setError("Couldn't read that PDF. If it's a scanned image, a CSV export or pasting the text will work.");
      setFileName("");
    } finally {
      setExtracting(false);
    }
  };

  const canAnalyse = (text.trim().length > 0 || pdfBase64.length > 0) && !loading && !extracting;

  const analyse = async () => {
    setLoading(true); setError(null); setResult(null); setImported(false); setAddedKeys([]);
    try {
      const content = [];
      if (pdfBase64) {
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } });
      }
      const tail = pdfBase64 ? "The bank statement is attached as a PDF." : `Bank statement data:\n\n${text.slice(0, 100000)}`;
      content.push({ type: "text", text: analysisPrompt(data.categories?.length ? data.categories : CATEGORIES) + "\n\n" + tail });
      const res = await fetch("/.netlify/functions/analyse-statement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const json = await res.json();
      const raw = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
      setResult(JSON.parse(clean));
    } catch (e) {
      setError("Couldn't read that one. A CSV export from your bank usually works best — or paste the transactions as text.");
    }
    setLoading(false);
  };

  const cat = result?.byCategory || [];
  const fallback = ["#0d9488", "#4f46e5", "#db2777", "#ea580c", "#7c3aed", "#0891b2", "#65a30d", "#64748b"];
  const recurringMonthly = (result?.recurring || []).filter((r) => r.cadence === "monthly");

  const personalAccts = data.accounts || [];
  const bizAccts = data.businessEnabled !== false ? (data.business?.accounts || []) : [];
  const defaultTarget = personalAccts[0] ? `personal:${personalAccts[0].id}` : (bizAccts[0] ? `business:${bizAccts[0].id}` : "personal:");
  const billTargetVal = billTarget || defaultTarget;
  const pushBill = (d, r) => {
    const [scope, id] = billTargetVal.split(":");
    const bill = {
      id: uid(), name: r.name || "Recurring",
      amount: Number(r.amount) || 0,
      day: Math.min(31, Math.max(1, Number(r.dayOfMonth) || 1)),
      accountId: id || "", paidMonth: "",
    };
    if (scope === "business") { if (!d.business.bills) d.business.bills = []; d.business.bills.push(bill); }
    else d.bills.push(bill);
  };

  const addOne = (r, i) => {
    patch((d) => { pushBill(d, r); return d; });
    setAddedKeys((k) => [...k, i]);
  };

  const importBills = () => {
    patch((d) => {
      (result?.recurring || []).forEach((r, idx) => {
        if (r.cadence !== "monthly" || addedKeys.includes(idx)) return;
        pushBill(d, r);
      });
      return d;
    });
    setImported(true);
  };

  return (
    <Card>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between">
        <div className="flex items-center gap-2.5 text-left">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
            <Sparkles size={18} />
          </span>
          <div>
            <p className="text-sm font-bold text-slate-900">Analyse a bank statement</p>
            <p className="text-xs text-slate-400">See where it really went — powered by Claude</p>
          </div>
        </div>
        <span className="text-slate-400">{open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-3">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-stone-300 px-4 py-6 text-center transition hover:border-indigo-400 hover:bg-indigo-50">
            <Upload size={20} className="text-slate-400" />
            <span className="text-sm font-medium text-slate-600">{extracting ? "Reading the PDF…" : (fileName || "Upload a CSV or PDF")}</span>
            <span className="text-xs text-slate-400">tap to choose a file</span>
            <input type="file" accept=".csv,.txt,.pdf" onChange={onFile} className="hidden" />
          </label>
          <p className="text-center text-xs text-slate-400">or paste your transactions below</p>
          <textarea
            className={`${inputCls} h-24 resize-none`}
            placeholder="Paste statement text or CSV here…"
            value={text}
            onChange={(e) => { setText(e.target.value); setPdfBase64(""); setFileName(""); }}
          />
          <button onClick={analyse} disabled={!canAnalyse} className={`${btnPrimary} w-full`}
            style={{ opacity: canAnalyse ? 1 : 0.5 }}>
            {loading ? "Reading it…" : <><Sparkles size={16} /> Analyse</>}
          </button>
          <p className="text-xs leading-relaxed text-slate-400">
            Heads up: to read it, the statement is sent to Claude. Everything else in this app stays on your device.
          </p>

          {error && <p className="rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</p>}

          {result && (
            <div className="space-y-4 pt-1">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-xs text-slate-400">{fileName ? `From ${fileName}` : "Your last analysis"}</p>
                <button
                  onClick={() => { setResult(null); setFileName(""); setImported(false); setAddedKeys([]); setText(""); }}
                  className="shrink-0 text-xs font-medium text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
                >
                  Clear
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Money in" value={gbp0(result.totalIn || 0)} accent="text-teal-700" />
                <Stat label="Money out" value={gbp0(result.totalOut || 0)} accent="text-rose-600" />
              </div>
              {result.period && <p className="text-center text-xs text-slate-400">{result.period}</p>}

              {cat.length > 0 && (
                <div>
                  <Eyebrow>Where it went</Eyebrow>
                  <div className="mt-2" style={{ height: 190 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={cat} dataKey="amount" nameKey="category" innerRadius={48} outerRadius={76} paddingAngle={2} stroke="none">
                          {cat.map((e, i) => <Cell key={i} fill={CATEGORY_COLOURS[e.category] || fallback[i % 8]} />)}
                        </Pie>
                        <Tooltip formatter={(v) => gbp(v)} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="mt-1 space-y-1">
                    {cat.map((c, i) => {
                      const items = c.items || [];
                      const isOpen = expandedCat === c.category;
                      return (
                        <li key={i}>
                          <button
                            onClick={() => setExpandedCat(isOpen ? null : c.category)}
                            className="flex w-full items-center justify-between rounded-lg px-1.5 py-1 text-sm transition hover:bg-stone-50"
                          >
                            <span className="flex items-center gap-2 text-slate-600">
                              <Dot color={CATEGORY_COLOURS[c.category] || fallback[i % 8]} /> {c.category}
                              {items.length > 0 && (
                                <ChevronDown size={14} className={`text-slate-400 transition ${isOpen ? "rotate-180" : ""}`} />
                              )}
                            </span>
                            <span className="font-semibold tabular-nums text-slate-900">{gbp(c.amount)}</span>
                          </button>
                          {isOpen && items.length > 0 && (
                            <ul className="mb-1 ml-4 mt-1 space-y-1 border-l border-stone-200 pl-3">
                              {items.map((it, j) => (
                                <li key={j} className="flex items-start justify-between gap-2 text-xs">
                                  <span className="min-w-0 flex-1 truncate text-slate-500">
                                    {it.description}
                                    {it.date ? <span className="text-slate-400"> · {it.date}</span> : null}
                                  </span>
                                  <span className="shrink-0 tabular-nums text-slate-600">{gbp(it.amount)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {(result.recurring || []).length > 0 && (
                <div>
                  <Eyebrow>Recurring &amp; subscriptions</Eyebrow>
                  {recurringMonthly.length > 0 && !imported && (personalAccts.length > 0 || bizAccts.length > 0) && (
                    <div className="mt-2">
                      <label className="mb-1 block text-xs font-medium text-slate-500">Add these bills to</label>
                      <select value={billTargetVal} onChange={(e) => setBillTarget(e.target.value)} className={inputCls}>
                        {personalAccts.length > 0 && (
                          <optgroup label="Personal">
                            {personalAccts.map((a) => <option key={a.id} value={`personal:${a.id}`}>{a.name}</option>)}
                          </optgroup>
                        )}
                        {bizAccts.length > 0 && (
                          <optgroup label="Business">
                            {bizAccts.map((a) => <option key={a.id} value={`business:${a.id}`}>{a.name}</option>)}
                          </optgroup>
                        )}
                      </select>
                      {billTargetVal.startsWith("business:") && (
                        <p className="mt-1 text-xs text-slate-400">These will be added to your business bills.</p>
                      )}
                    </div>
                  )}
                  <ul className="mt-2 space-y-1.5">
                    {result.recurring.map((r, i) => {
                      const isMonthly = r.cadence === "monthly";
                      const isAdded = addedKeys.includes(i) || (imported && isMonthly);
                      return (
                        <li key={i} className="flex items-center justify-between gap-2 rounded-xl border border-stone-100 px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-800">{r.name}</p>
                            <p className="text-xs text-slate-400">
                              {r.cadence}{r.type === "subscription" ? " · subscription" : ""}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-sm font-bold tabular-nums text-slate-900">{gbp(r.amount)}</span>
                            {isMonthly && (
                              isAdded ? (
                                <span className="flex items-center gap-1 text-xs font-medium text-teal-600">
                                  <Check size={13} /> Added
                                </span>
                              ) : (
                                <button
                                  onClick={() => addOne(r, i)}
                                  className="flex items-center gap-1 rounded-lg border border-teal-200 bg-teal-50 px-2 py-1 text-xs font-medium text-teal-700 transition hover:bg-teal-100"
                                >
                                  <Plus size={13} /> Add
                                </button>
                              )
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {recurringMonthly.length > 0 && (
                    imported ? (
                      <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-teal-700">
                        <Check size={15} /> Added {recurringMonthly.length} to your Bills
                      </p>
                    ) : (
                      <button onClick={importBills} className={`${btnGhost} mt-2 w-full`}>
                        <Plus size={15} /> Add the {recurringMonthly.length} monthly ones to my Bills
                      </button>
                    )
                  )}
                </div>
              )}

              {(result.largest || []).length > 0 && (
                <div>
                  <Eyebrow>Biggest one-offs</Eyebrow>
                  <ul className="mt-2 space-y-1.5">
                    {result.largest.map((t, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 truncate text-slate-600">{t.description}{t.date ? ` · ${t.date}` : ""}</span>
                        <span className="font-semibold tabular-nums text-slate-900">{gbp(t.amount)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(result.insights || []).length > 0 && (
                <div className="rounded-2xl bg-indigo-50 p-4">
                  <Eyebrow>Worth knowing</Eyebrow>
                  <ul className="mt-2 space-y-2">
                    {result.insights.map((ins, i) => (
                      <li key={i} className="flex gap-2 text-sm text-indigo-900">
                        <span className="text-indigo-400">•</span><span>{ins}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  SPENDING                                                           */
/* ------------------------------------------------------------------ */

function Spend({ data, acctById, spentThisMonth, patch }) {
  const cards = data.cards || [];
  const cats = data.categories?.length ? data.categories : CATEGORIES;
  const firstSrc = data.accounts[0] ? `a:${data.accounts[0].id}` : cards[0] ? `c:${cards[0].id}` : "";
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(cats[0]);
  const [srcVal, setSrcVal] = useState(firstSrc);
  const [date, setDate] = useState(localISO());
  const [note, setNote] = useState("");
  const [subtract, setSubtract] = useState(true);
  const [editing, setEditing] = useState(null);

  const srcKind = srcVal.startsWith("c:") ? "card" : "account";
  const srcId = srcVal.slice(2);
  const cardById = (id) => cards.find((c) => c.id === id);
  const srcName =
    srcKind === "card" ? cardById(srcId)?.name || "the card" : acctById[srcId]?.name || "the account";
  const toggleLabel =
    srcKind === "card" ? `Add it to ${srcName}'s balance` : `Take it off ${srcName}'s balance`;

  const add = () => {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const isCard = srcKind === "card";
    patch((d) => {
      d.transactions.push({
        id: uid(), amount: amt, category,
        accountId: srcId, isCard,
        date: date || localISO(), note: note.trim(), applied: subtract,
      });
      if (subtract) {
        if (isCard) {
          const c = (d.cards || []).find((x) => x.id === srcId);
          if (c) c.balance = (c.balance || 0) + amt;
        } else {
          const a = d.accounts.find((x) => x.id === srcId);
          if (a) a.balance = balanceOf(a) - amt;
        }
      }
      return d;
    });
    setAmount(""); setNote("");
  };

  const remove = (t) => {
    patch((d) => {
      if (t.applied) {
        if (t.isCard) {
          const c = (d.cards || []).find((x) => x.id === t.accountId);
          if (c) c.balance = (c.balance || 0) - t.amount;
        } else {
          const a = d.accounts.find((x) => x.id === t.accountId);
          if (a) a.balance = balanceOf(a) + t.amount;
        }
      }
      d.transactions = d.transactions.filter((x) => x.id !== t.id);
      return d;
    });
  };

  const monthTx = data.transactions.filter((t) => isThisMonth(t.date)).sort((a, b) => (a.date < b.date ? 1 : -1));

  const byCat = useMemo(() => {
    const m = {};
    monthTx.forEach((t) => (m[t.category] = (m[t.category] || 0) + t.amount));
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [monthTx]);

  const trends = useMemo(() => categoryTrends(data.transactions), [data.transactions]);

  return (
    <div className="space-y-4 lg:columns-2 lg:gap-5 lg:space-y-0 lg:[&>*]:mb-5 lg:[&>*]:break-inside-avoid">
      <SummaryBar label="Spent this month" value={spentThisMonth} sub="not counting bills & loans" />

      <StatementAnalyser data={data} patch={patch} />

      <Card>
        <Eyebrow>Quick add a spend</Eyebrow>
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount (£)">
              <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00"
                value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Date">
              <input className={inputCls} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Category">
            <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              {cats.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Paid with">
            <select className={inputCls} value={srcVal} onChange={(e) => setSrcVal(e.target.value)}>
              {data.accounts.length > 0 && (
                <optgroup label="Accounts">
                  {data.accounts.map((a) => <option key={a.id} value={`a:${a.id}`}>{a.name}</option>)}
                </optgroup>
              )}
              {cards.length > 0 && (
                <optgroup label="Credit cards">
                  {cards.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}
                </optgroup>
              )}
            </select>
          </Field>
          <Field label="Note (optional)">
            <input className={inputCls} placeholder="What was it?" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <CheckToggle checked={subtract} onChange={setSubtract} label={toggleLabel} />
          <button onClick={add} className={`${btnPrimary} w-full`}>
            <Plus size={16} /> Log it
          </button>
        </div>
      </Card>

      {byCat.length > 0 && (
        <Card>
          <Eyebrow>Where it's going · this month</Eyebrow>
          <div className="mt-2" style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={byCat} dataKey="value" nameKey="name" innerRadius={52} outerRadius={80} paddingAngle={2} stroke="none">
                  {byCat.map((e, i) => <Cell key={e.name} fill={CATEGORY_COLOURS[e.name] || ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v) => gbp(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 space-y-2">
            {byCat.map((c, i) => (
              <li key={c.name} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-slate-600">
                  <Dot color={CATEGORY_COLOURS[c.name] || ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]} /> {c.name}
                </span>
                <span className="font-semibold tabular-nums text-slate-900">{gbp(c.value)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {trends.length > 0 && trends.some((t) => t.prev > 0) && (
        <Card>
          <Eyebrow>This month vs last</Eyebrow>
          <p className="mb-3 mt-1 text-sm text-slate-500">How your logged spending compares with last month.</p>
          <ul className="space-y-2.5">
            {trends.map((t, i) => {
              const diff = t.now - t.prev;
              const pct = t.prev > 0 ? Math.round((diff / t.prev) * 100) : null;
              const up = diff > 0;
              return (
                <li key={t.category} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                    <Dot color={CATEGORY_COLOURS[t.category] || ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]} />
                    <span className="truncate">{t.category}</span>
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm font-semibold tabular-nums text-slate-900">{gbp0(t.now)}</span>
                    {t.prev === 0 ? (
                      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">new</span>
                    ) : Math.abs(diff) < 1 ? (
                      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">level</span>
                    ) : (
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${up ? "bg-rose-50 text-rose-600" : "bg-teal-50 text-teal-700"}`}>
                        {up ? "↑" : "↓"} {Math.abs(pct)}%
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11px] text-slate-400">Based on what you've logged — the more you log, the truer this gets.</p>
        </Card>
      )}

      <Card>
        <Eyebrow>Recent spends</Eyebrow>
        {monthTx.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">Nothing logged this month yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-stone-100">
            {monthTx.slice(0, 30).map((t) => {
              const src = t.isCard ? cardById(t.accountId) : acctById[t.accountId];
              return (
                <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{t.note || t.category}</p>
                    <p className="text-xs text-slate-400">
                      {t.category} ·{" "}
                      {new Date(t.date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                      {src ? ` · ${src.name}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold tabular-nums text-slate-900">{gbp(t.amount)}</span>
                    <EditBtn onClick={() => setEditing({ ...t, src: t.isCard ? `c:${t.accountId}` : `a:${t.accountId}` })} />
                    <button onClick={() => remove(t)} className="text-slate-300 hover:text-rose-500">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {editing && (
        <EditModal
          title="Edit transaction"
          item={editing}
          fields={[
            { key: "note", label: "Note", type: "text" },
            { key: "amount", label: "Amount (£)", type: "money" },
            { key: "category", label: "Category", type: "select", options: cats.map((c) => ({ value: c, label: c })) },
            { key: "src", label: "Paid with", type: "select", options: [
              ...data.accounts.map((a) => ({ value: `a:${a.id}`, label: a.name })),
              ...cards.map((c) => ({ value: `c:${c.id}`, label: `${c.name} (card)` })),
            ] },
          ]}
          onClose={() => setEditing(null)}
          onSave={(vals) => {
            patch((d) => {
              const t = d.transactions.find((x) => x.id === editing.id);
              if (!t) return d;
              // reverse the old balance effect
              if (t.applied) {
                if (t.isCard) { const c = (d.cards || []).find((x) => x.id === t.accountId); if (c) c.balance = (c.balance || 0) - t.amount; }
                else { const a = d.accounts.find((x) => x.id === t.accountId); if (a) a.balance = balanceOf(a) + t.amount; }
              }
              const newIsCard = String(vals.src).startsWith("c:");
              const newId = String(vals.src).slice(2);
              t.amount = vals.amount; t.category = vals.category; t.note = vals.note;
              t.accountId = newId; t.isCard = newIsCard;
              // re-apply with the new amount / destination
              if (t.applied) {
                if (newIsCard) { const c = (d.cards || []).find((x) => x.id === newId); if (c) c.balance = (c.balance || 0) + t.amount; }
                else { const a = d.accounts.find((x) => x.id === newId); if (a) a.balance = balanceOf(a) - t.amount; }
              }
              return d;
            });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  LOANS — generic list                                              */
/* ------------------------------------------------------------------ */

function LoanList({ loans, accounts, onAdd, onDelete, onLogPayment, onDeletePayment, onEdit, emptyText, onAddToBills, linkedIds = [] }) {
  const acctById = useMemo(() => {
    const m = {};
    accounts.forEach((a) => (m[a.id] = a));
    return m;
  }, [accounts]);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [original, setOriginal] = useState("");
  const [monthly, setMonthly] = useState("");
  const [apr, setApr] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [editing, setEditing] = useState(null);
  const [billFor, setBillFor] = useState(null);
  const [billDay, setBillDay] = useState("1");
  const [billAcct, setBillAcct] = useState("");

  const add = () => {
    const orig = parseFloat(original);
    const mon = parseFloat(monthly);
    const rate = parseFloat(apr);
    if (!name.trim() || !Number.isFinite(orig)) return;
    onAdd({
      id: uid(), name: name.trim(), original: orig,
      monthly: Number.isFinite(mon) ? mon : 0,
      apr: Number.isFinite(rate) ? rate : 0,
      accountId: accountId || accounts[0]?.id || "", payments: [],
    });
    setName(""); setOriginal(""); setMonthly(""); setApr(""); setOpen(false);
  };

  return (
    <div className="space-y-4">
      {!open ? (
        <button onClick={() => setOpen(true)} className={`${btnPrimary} w-full`}>
          <Plus size={16} /> Add a loan or debt
        </button>
      ) : (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <Eyebrow>New loan / debt</Eyebrow>
            <button onClick={() => setOpen(false)} className="text-slate-400"><X size={18} /></button>
          </div>
          <div className="space-y-3">
            <Field label="Name">
              <input className={inputCls} placeholder="e.g. Equipment finance"
                value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Balance owed (£)">
                <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00"
                  value={original} onChange={(e) => setOriginal(e.target.value)} />
              </Field>
              <Field label="Monthly payment (£)">
                <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00"
                  value={monthly} onChange={(e) => setMonthly(e.target.value)} />
              </Field>
            </div>
            <Field label="Interest rate (APR %) — optional, sharpens the payoff estimate">
              <input className={inputCls} type="number" inputMode="decimal" placeholder="e.g. 7.9"
                value={apr} onChange={(e) => setApr(e.target.value)} />
            </Field>
            <Field label="Paid from">
              <select className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.length === 0 && <option value="">No accounts yet</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <button onClick={add} className={`${btnPrimary} w-full`}>
              <Check size={16} /> Save
            </button>
          </div>
        </Card>
      )}

      {loans.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-slate-400">{emptyText}</p>
        </Card>
      ) : (
        loans.map((l) => {
          const paid = l.payments.reduce((s, p) => s + (p.amount || 0), 0);
          const remaining = Math.max(0, l.original - paid);
          const pct = l.original > 0 ? Math.min(100, (paid / l.original) * 100) : 0;
          const a = acctById[l.accountId];
          const m = monthsLeft(remaining, l.monthly, l.apr);
          const term = termLabel(m);
          const payoff = payoffDate(m);
          return (
            <Card key={l.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-base font-bold text-slate-900">{l.name}</p>
                  {a && (
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
                      <Dot color={a.color} /> {a.name}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <EditBtn onClick={() => setEditing(l)} />
                  <button onClick={() => onDelete(l.id)} className="text-slate-300 hover:text-rose-500">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-end justify-between">
                <div>
                  <p className="text-xs text-slate-400">Still owed</p>
                  <p className="text-3xl font-bold tabular-nums text-slate-900">{gbp(remaining)}</p>
                </div>
                <p className="text-sm font-semibold text-teal-700">{gbp0(paid)} paid off</p>
              </div>

              <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-stone-100">
                <div className="h-full rounded-full bg-teal-500 transition-all" style={{ width: `${pct}%` }} />
              </div>

              {term && (
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className={m === Infinity ? "font-medium text-rose-500" : "text-slate-400"}>
                    {m === Infinity
                      ? "Payment doesn't cover the interest"
                      : m === 0
                      ? "Cleared"
                      : `About ${term} left${l.apr > 0 ? "" : " (est.)"}`}
                  </span>
                  {payoff && <span className="font-medium text-slate-500">clear by {payoff}</span>}
                </div>
              )}

              <div className="mt-4 flex items-center gap-2">
                <button onClick={() => onLogPayment(l.id, l.monthly)} className={`${btnPrimary} flex-1`} disabled={!l.monthly}>
                  <ArrowDownCircle size={16} /> Log {gbp0(l.monthly)} payment
                </button>
              </div>

              {onAddToBills && l.monthly > 0 && (
                linkedIds.includes(l.id) ? (
                  <p className="mt-2 text-center text-xs font-medium text-teal-600">✓ Monthly payment is in your Bills</p>
                ) : billFor === l.id ? (
                  <div className="mt-2 space-y-2 rounded-xl border border-stone-200 p-2.5">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 text-xs text-slate-500">Leaves on day</span>
                      <input type="number" min="1" max="31" value={billDay} onChange={(e) => setBillDay(e.target.value)}
                        className="w-14 rounded-lg border border-stone-200 px-2 py-1 text-center text-sm" />
                    </div>
                    {accounts.length > 0 && (
                      <label className="block">
                        <span className="mb-1 block text-xs text-slate-500">Comes out of</span>
                        <select value={billAcct} onChange={(e) => setBillAcct(e.target.value)}
                          className="w-full rounded-lg border border-stone-200 px-2 py-1.5 text-sm">
                          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </label>
                    )}
                    <div className="flex gap-2">
                      <button onClick={() => setBillFor(null)} className="flex-1 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs font-medium text-slate-500">Cancel</button>
                      <button onClick={() => { onAddToBills(l, parseInt(billDay) || 1, billAcct || l.accountId || accounts[0]?.id || ""); setBillFor(null); }}
                        className="flex-1 rounded-lg bg-teal-600 px-2.5 py-1.5 text-xs font-semibold text-white">Add to Bills</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setBillFor(l.id); setBillDay("1"); setBillAcct(l.accountId || accounts[0]?.id || ""); }}
                    className="mt-2 w-full text-center text-xs font-medium text-teal-600 hover:underline">
                    + Add {gbp0(l.monthly)} monthly payment to Bills
                  </button>
                )
              )}

              {l.payments.length > 0 && (
                <ul className="mt-3 space-y-1.5 border-t border-stone-100 pt-3">
                  {[...l.payments].reverse().slice(0, 6).map((p) => (
                    <li key={p.id} className="flex items-center justify-between text-xs text-slate-500">
                      <span>
                        {new Date(p.date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="font-semibold tabular-nums text-slate-700">{gbp(p.amount)}</span>
                        <button onClick={() => onDeletePayment(l.id, p.id)} className="text-slate-300 hover:text-rose-500">
                          <X size={13} />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })
      )}

      {editing && (
        <EditModal
          title="Edit loan / debt"
          item={editing}
          fields={[
            { key: "name", label: "Name", type: "text" },
            { key: "original", label: "Balance owed (£)", type: "money" },
            { key: "monthly", label: "Monthly payment (£)", type: "money" },
            { key: "apr", label: "Interest rate (APR %)", type: "percent" },
            { key: "accountId", label: "Paid from", type: "select", options: accounts.map((a) => ({ value: a.id, label: a.name })) },
          ]}
          onClose={() => setEditing(null)}
          onSave={(vals) => { onEdit(editing.id, vals); setEditing(null); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  LOANS TAB — personal | business                                   */
/* ------------------------------------------------------------------ */

function LoansTab({ data, drawnThisMonth, patch }) {
  const [seg, setSeg] = useState("personal");
  const businessOn = data.businessEnabled !== false;

  /* personal loan handlers */
  const pAdd = (loan) => patch((d) => { d.loans.push(loan); return d; });
  const pDel = (id) => patch((d) => { d.loans = d.loans.filter((x) => x.id !== id); return d; });
  const pPay = (id, amt) => patch((d) => {
    const l = d.loans.find((x) => x.id === id);
    if (l) l.payments.push({ id: uid(), date: localISO(), amount: amt });
    return d;
  });
  const pPayDel = (id, pid) => patch((d) => {
    const l = d.loans.find((x) => x.id === id);
    if (l) l.payments = l.payments.filter((x) => x.id !== pid);
    return d;
  });
  const pEdit = (id, vals) => patch((d) => {
    const l = d.loans.find((x) => x.id === id);
    if (l) { l.name = vals.name; l.original = vals.original; l.monthly = vals.monthly; l.apr = vals.apr; l.accountId = vals.accountId; }
    return d;
  });
  const addLoanToBills = (loan, day, accountId) => patch((d) => {
    const billId = uid();
    d.bills.push({
      id: billId, name: loan.name, amount: loan.monthly || 0,
      day: Math.min(31, Math.max(1, day || 1)),
      accountId: accountId || loan.accountId || d.accounts[0]?.id || "", paidMonth: "",
    });
    const l = d.loans.find((x) => x.id === loan.id);
    if (l) l.billId = billId;
    return d;
  });
  const personalLinkedLoanIds = data.loans
    .filter((l) => l.billId && data.bills.some((b) => b.id === l.billId))
    .map((l) => l.id);

  /* business loan handlers */
  const bAdd = (loan) => patch((d) => { d.business.loans.push(loan); return d; });
  const bDel = (id) => patch((d) => { d.business.loans = d.business.loans.filter((x) => x.id !== id); return d; });
  const bPay = (id, amt) => patch((d) => {
    const l = d.business.loans.find((x) => x.id === id);
    if (l) l.payments.push({ id: uid(), date: localISO(), amount: amt });
    return d;
  });
  const bPayDel = (id, pid) => patch((d) => {
    const l = d.business.loans.find((x) => x.id === id);
    if (l) l.payments = l.payments.filter((x) => x.id !== pid);
    return d;
  });
  const bEdit = (id, vals) => patch((d) => {
    const l = d.business.loans.find((x) => x.id === id);
    if (l) { l.name = vals.name; l.original = vals.original; l.monthly = vals.monthly; l.apr = vals.apr; l.accountId = vals.accountId; }
    return d;
  });
  const bizAddLoanToBills = (loan, day, accountId) => patch((d) => {
    if (!d.business.bills) d.business.bills = [];
    const billId = uid();
    d.business.bills.push({
      id: billId, name: loan.name, amount: loan.monthly || 0,
      day: Math.min(31, Math.max(1, day || 1)),
      accountId: accountId || loan.accountId || d.business.accounts[0]?.id || "", paidMonth: "",
    });
    const l = d.business.loans.find((x) => x.id === loan.id);
    if (l) l.billId = billId;
    return d;
  });
  const bizLinkedLoanIds = (data.business.loans || [])
    .filter((l) => l.billId && (data.business.bills || []).some((b) => b.id === l.billId))
    .map((l) => l.id);

  const biz = data.business;
  const bizCash = biz.accounts.filter((a) => !a.isTax).reduce((s, a) => s + balanceOf(a), 0);
  const bizTaxAside = biz.accounts.filter((a) => a.isTax).reduce((s, a) => s + balanceOf(a), 0);
  const bizOwed = biz.loans.reduce((s, l) => s + owedOn(l), 0);
  const bizMonthly = biz.loans.reduce((s, l) => s + (l.monthly || 0), 0);
  const bizRemaining = biz.loans
    .filter((l) => (l.monthly || 0) > 0 && !l.payments.some((p) => isThisMonth(p.date)) && !(l.billId && (biz.bills || []).some((b) => b.id === l.billId)))
    .reduce((s, l) => s + (l.monthly || 0), 0);
  const bizBills = biz.bills || [];
  const bizBillsRemaining = bizBills
    .filter((b) => dateInThisMonth(nextDue(b.day)) && b.paidMonth !== monthKey())
    .reduce((s, b) => s + (b.amount || 0), 0);
  const bizHeadroom = bizCash - bizRemaining - bizBillsRemaining;

  /* combined debt picture (personal + business + cards) */
  const cards = data.cards || [];
  const sumPaid = (arr) => arr.reduce((s, l) => s + l.payments.reduce((x, p) => x + (p.amount || 0), 0), 0);
  const pOwed = data.loans.reduce((s, l) => s + owedOn(l), 0);
  const pPaid = sumPaid(data.loans);
  const pMonthly = data.loans.reduce((s, l) => s + (l.monthly || 0), 0);
  const bPaid = sumPaid(biz.loans);
  const cardsOwed = cards.reduce((s, c) => s + Math.max(0, c.balance || 0), 0);
  const cardsMonthly = cards.reduce((s, c) => s + (c.minPayment || 0), 0);
  const loansOwed = pOwed + bizOwed;
  const loansPaid = pPaid + bPaid;
  const totalOwed = loansOwed + cardsOwed;
  const loanOriginal = loansOwed + loansPaid;
  const paidPct = loanOriginal > 0 ? (loansPaid / loanOriginal) * 100 : 0;
  const totalMonthly = pMonthly + bizMonthly + cardsMonthly;
  const anyDebt = data.loans.length + biz.loans.length + cards.length > 0;

  return (
    <div className="space-y-4 lg:columns-2 lg:gap-5 lg:space-y-0 lg:[&>*]:mb-5 lg:[&>*]:break-inside-avoid">
      {anyDebt && (
        <Card>
          <Eyebrow>Your total debt</Eyebrow>
          <div className="mt-2 flex items-end justify-between">
            <div>
              <p className="text-xs text-slate-400">Still owed, everything</p>
              <p className="text-4xl font-bold tabular-nums text-slate-900">{gbp0(totalOwed)}</p>
            </div>
            <div className="text-right">
              <p className="text-xl font-bold tabular-nums text-slate-700">{gbp0(totalMonthly)}</p>
              <p className="text-xs text-slate-400">/mo across all debt</p>
            </div>
          </div>

          {loanOriginal > 0 && (
            <>
              <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-stone-100">
                <div className="h-full rounded-full bg-teal-500 transition-all" style={{ width: `${paidPct}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-slate-400">
                {paidPct.toFixed(0)}% of your loans cleared · {gbp0(loansPaid)} repaid
              </p>
            </>
          )}

          <ul className="mt-4 space-y-2">
            <li className="flex items-center justify-between rounded-2xl bg-stone-50 px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm font-medium text-slate-600">
                <Wallet size={15} /> Personal loans
              </span>
              <span className="text-right">
                <span className="block text-sm font-bold tabular-nums text-slate-900">{gbp0(pOwed)}</span>
                {pMonthly > 0 && <span className="block text-xs text-slate-400">{gbp0(pMonthly)}/mo</span>}
              </span>
            </li>
            <li className="flex items-center justify-between rounded-2xl bg-stone-50 px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm font-medium text-slate-600">
                <Briefcase size={15} /> Business loans
              </span>
              <span className="text-right">
                <span className="block text-sm font-bold tabular-nums text-slate-900">{gbp0(bizOwed)}</span>
                {bizMonthly > 0 && <span className="block text-xs text-slate-400">{gbp0(bizMonthly)}/mo</span>}
              </span>
            </li>
            <li className="flex items-center justify-between rounded-2xl bg-stone-50 px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm font-medium text-slate-600">
                <CreditCard size={15} /> Credit cards
              </span>
              <span className="text-right">
                <span className="block text-sm font-bold tabular-nums text-slate-900">{gbp0(cardsOwed)}</span>
                {cardsMonthly > 0 && <span className="block text-xs text-slate-400">{gbp0(cardsMonthly)}/mo min</span>}
              </span>
            </li>
          </ul>
        </Card>
      )}

      <div className="flex rounded-2xl bg-stone-100 p-1">
        <button
          onClick={() => setSeg("personal")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-semibold transition ${
            seg === "personal" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
          }`}
        >
          <Wallet size={15} /> Personal
        </button>
        {businessOn && (
        <button
          onClick={() => setSeg("business")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-semibold transition ${
            seg === "business" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
          }`}
        >
          <Briefcase size={15} /> Business
        </button>
        )}
        <button
          onClick={() => setSeg("cards")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-semibold transition ${
            seg === "cards" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
          }`}
        >
          <CreditCard size={15} /> Cards
        </button>
      </div>

      {seg === "personal" ? (
        <>
          <SummaryBar label="Going to your loans monthly"
            value={data.loans.reduce((s, l) => s + (l.monthly || 0), 0)}
            sub="these come out of your personal accounts" />
          <LoanList
            loans={data.loans}
            accounts={data.accounts}
            onAdd={pAdd}
            onDelete={pDel}
            onLogPayment={pPay}
            onDeletePayment={pPayDel}
            onEdit={pEdit}
            onAddToBills={addLoanToBills}
            linkedIds={personalLinkedLoanIds}
            emptyText="No personal debts tracked yet. Add one to watch the balance shrink every time you log a payment."
          />
        </>
      ) : seg === "business" && businessOn ? (
        <>
          {/* business overview */}
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Business available" value={gbp0(bizCash)} accent="text-cyan-700" />
            <Stat label="Total owed" value={gbp0(bizOwed)} accent="text-slate-900" />
            <Stat label="Loans per month" value={gbp0(bizMonthly)} accent="text-slate-900" />
            <Stat label="Headroom this month" value={gbp0(bizHeadroom)}
              accent={bizHeadroom >= 0 ? "text-teal-700" : "text-rose-600"} />
          </div>
          {bizTaxAside > 0 && (
            <p className="mt-2 text-xs text-slate-400">
              Plus {gbp0(bizTaxAside)} held in VAT/tax accounts — kept out of the figures above.
            </p>
          )}

          <div className="rounded-2xl border border-cyan-200 bg-cyan-50 p-3.5 text-xs leading-relaxed text-cyan-900">
            You've taken <span className="font-semibold">{gbp0(drawnThisMonth)}</span> out to yourself
            this month. This is a light tracker for cash-flow awareness — your books and accountant
            stay the source of truth for what the company can actually pay out.
          </div>

          {/* business loans */}
          <div>
            <p className="mb-2 mt-1 px-1 text-xs font-semibold uppercase tracking-widest text-slate-400">
              Business loans
            </p>
            <LoanList
              loans={biz.loans}
              accounts={biz.accounts}
              onAdd={bAdd}
              onDelete={bDel}
              onLogPayment={bPay}
              onDeletePayment={bPayDel}
              onEdit={bEdit}
              onAddToBills={bizAddLoanToBills}
              linkedIds={bizLinkedLoanIds}
              emptyText="No business loans tracked yet. Add your equipment finance, asset finance and any business loans here."
            />
          </div>
        </>
      ) : (
        <CardsSection cards={cards} accounts={data.accounts} bills={data.bills} patch={patch} />
      )}
    </div>
  );
}

function BusinessBills({ bills, accounts, patch }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState("1");
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [editing, setEditing] = useState(null);
  const thisMK = monthKey();
  const acctById = Object.fromEntries(accounts.map((a) => [a.id, a]));

  const add = () => {
    const amt = parseFloat(amount);
    if (!name.trim() || !Number.isFinite(amt)) return;
    patch((d) => {
      if (!d.business.bills) d.business.bills = [];
      d.business.bills.push({
        id: uid(), name: name.trim(), amount: amt,
        day: Math.min(31, Math.max(1, parseInt(day) || 1)),
        accountId: accountId || accounts[0]?.id || "", paidMonth: "",
      });
      return d;
    });
    setName(""); setAmount(""); setDay("1"); setOpen(false);
  };
  const togglePaid = (b) => patch((d) => {
    const x = (d.business.bills || []).find((y) => y.id === b.id);
    if (x) x.paidMonth = x.paidMonth === thisMK ? "" : thisMK;
    return d;
  });
  const del = (id) => patch((d) => { d.business.bills = (d.business.bills || []).filter((x) => x.id !== id); return d; });
  const saveEdit = (vals) => {
    patch((d) => {
      const b = (d.business.bills || []).find((x) => x.id === editing.id);
      if (b) { b.name = vals.name; b.amount = vals.amount; b.day = Math.min(31, Math.max(1, vals.day || 1)); b.accountId = vals.accountId; }
      return d;
    });
    setEditing(null);
  };

  const sorted = [...bills].sort((a, b) => a.day - b.day);
  const total = bills.reduce((s, b) => s + (b.amount || 0), 0);
  const paidCount = sorted.filter((b) => b.paidMonth === thisMK).length;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <Eyebrow>Business bills</Eyebrow>
        <span className="text-xs tabular-nums text-slate-400">
          {gbp0(total)}/mo{paidCount > 0 ? ` · ${paidCount} paid` : ""}
        </span>
      </div>
      {sorted.length > 0 && (
        <ul className="mb-3 mt-3 divide-y divide-stone-100">
          {sorted.map((b) => {
            const a = acctById[b.accountId];
            const paid = b.paidMonth === thisMK;
            return (
              <li key={b.id} className={`flex items-center justify-between gap-3 py-2.5 ${paid ? "opacity-55" : ""}`}>
                <div className="flex min-w-0 items-center gap-2.5">
                  <button
                    onClick={() => togglePaid(b)}
                    title={paid ? "Paid this month — tap to undo" : "Mark paid this month"}
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition ${paid ? "border-teal-600 bg-teal-600 text-white" : "border-stone-300 text-transparent hover:border-teal-400"}`}
                  >
                    <Check size={12} />
                  </button>
                  <div className="flex h-8 w-8 shrink-0 flex-col items-center justify-center rounded-lg bg-stone-100">
                    <span className="text-xs font-bold leading-none text-slate-700">{b.day}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{b.name}</p>
                    <p className="truncate text-xs text-slate-400">{paid ? "Paid this month" : (a ? a.name : "—")}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold tabular-nums text-slate-900">{gbp(b.amount)}</span>
                  <EditBtn onClick={() => setEditing(b)} />
                  <button onClick={() => del(b.id)} className="text-slate-300 hover:text-rose-500"><Trash2 size={15} /></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!open ? (
        <button onClick={() => setOpen(true)} className={`${btnGhost} mt-3 w-full`}>
          <Plus size={15} /> Add a business bill
        </button>
      ) : (
        <div className="mt-3 space-y-3 rounded-xl border border-stone-200 p-3">
          <Field label="What is it?">
            <input className={inputCls} placeholder="e.g. Software, insurance" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount (£)">
              <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Day of month">
              <input className={inputCls} type="number" inputMode="numeric" min="1" max="31" value={day} onChange={(e) => setDay(e.target.value)} />
            </Field>
          </div>
          {accounts.length > 0 && (
            <Field label="Comes out of">
              <select className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          )}
          <div className="flex gap-2">
            <button onClick={() => setOpen(false)} className={`${btnGhost} flex-1`}>Cancel</button>
            <button onClick={add} className={`${btnPrimary} flex-1`}><Check size={15} /> Save</button>
          </div>
        </div>
      )}
      {editing && (
        <EditModal
          title="Edit business bill"
          item={editing}
          fields={[
            { key: "name", label: "What is it?", type: "text" },
            { key: "amount", label: "Amount (£)", type: "money" },
            { key: "day", label: "Day of month", type: "number" },
            ...(accounts.length > 0 ? [{ key: "accountId", label: "Comes out of", type: "select", options: accounts.map((a) => ({ value: a.id, label: a.name })) }] : []),
          ]}
          onClose={() => setEditing(null)}
          onSave={saveEdit}
        />
      )}
    </Card>
  );
}

function BusinessAccounts({ accounts, onAdd, onDelete, onBalance, onEdit }) {
  const [open, setOpen] = useState(accounts.length === 0);
  const [name, setName] = useState("");
  const [type, setType] = useState("Current");
  const [color, setColor] = useState(ACCOUNT_COLORS[4]);
  const [balance, setBalance] = useState("");
  const [editing, setEditing] = useState(null);

  const add = () => {
    if (!name.trim()) return;
    const bal = parseFloat(balance);
    onAdd({ id: uid(), name: name.trim(), type, color, balance: Number.isFinite(bal) ? bal : 0 });
    setName(""); setBalance("");
  };

  return (
    <Card>
      <Eyebrow>Business accounts &amp; cash</Eyebrow>
      {accounts.length > 0 && (
        <ul className="mb-3 mt-3 space-y-2">
          {accounts.map((a) => (
            <li key={a.id} className="rounded-xl border border-stone-100 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Dot color={a.color} />
                  <div>
                    <p className="text-sm font-medium text-slate-800">{a.name}</p>
                    <p className="text-xs text-slate-400">
                      {a.type}{a.isTax && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">VAT/tax</span>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <EditBtn onClick={() => setEditing(a)} />
                  <button onClick={() => onDelete(a.id)} className="text-slate-300 hover:text-rose-500">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm font-medium text-slate-400">£</span>
                <input className={inputCls} type="number" inputMode="decimal"
                  value={Number.isFinite(a.balance) ? a.balance : ""}
                  onChange={(e) => onBalance(a.id, e.target.value)} placeholder="Current balance" />
              </div>
            </li>
          ))}
        </ul>
      )}

      {open ? (
        <div className="space-y-3 rounded-2xl bg-stone-50 p-3">
          <Field label="Account name">
            <input className={inputCls} placeholder="e.g. Business current" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
                {["Current", "Savings", "Other"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Balance now (£)">
              <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00"
                value={balance} onChange={(e) => setBalance(e.target.value)} />
            </Field>
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-slate-500">Colour</span>
            <div className="flex flex-wrap gap-2">
              {ACCOUNT_COLORS.map((c) => (
                <button key={c} onClick={() => setColor(c)}
                  className={`h-8 w-8 rounded-full transition ${color === c ? "ring-2 ring-slate-900 ring-offset-2" : ""}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
          <button onClick={add} className={`${btnPrimary} w-full`}>
            <Plus size={16} /> Add account
          </button>
        </div>
      ) : (
        <button onClick={() => setOpen(true)} className={`${btnGhost} mt-1 w-full`}>
          <Plus size={15} /> Add a business account
        </button>
      )}

      {editing && (
        <EditModal
          title="Edit account"
          item={editing}
          fields={[
            { key: "name", label: "Account name", type: "text" },
            { key: "type", label: "Type", type: "select", options: ["Current", "Savings", "Other"].map((t) => ({ value: t, label: t })) },
            { key: "balance", label: "Balance now (£) — use − if overdrawn", type: "signedmoney" },
            { key: "overdraft", label: "Overdraft limit (£, if any)", type: "money" },
            { key: "isTax", label: "VAT/tax savings account (kept aside)", type: "toggle" },
          ]}
          onClose={() => setEditing(null)}
          onSave={(vals) => { onEdit(editing.id, vals); setEditing(null); }}
        />
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  CREDIT CARDS                                                       */
/* ------------------------------------------------------------------ */

function CardsSection({ cards, accounts, bills = [], patch }) {
  const [open, setOpen] = useState(cards.length === 0);
  const [name, setName] = useState("");
  const [balance, setBalance] = useState("");
  const [limit, setLimit] = useState("");
  const [apr, setApr] = useState("");
  const [minPayment, setMinPayment] = useState("");
  const [color, setColor] = useState(ACCOUNT_COLORS[6]);
  const [editing, setEditing] = useState(null);

  const addCard = () => {
    if (!name.trim()) return;
    const bal = parseFloat(balance);
    const lim = parseFloat(limit);
    const rate = parseFloat(apr);
    const min = parseFloat(minPayment);
    patch((d) => {
      if (!d.cards) d.cards = [];
      d.cards.push({
        id: uid(), name: name.trim(),
        balance: Number.isFinite(bal) ? bal : 0,
        limit: Number.isFinite(lim) ? lim : 0,
        apr: Number.isFinite(rate) ? rate : 0,
        minPayment: Number.isFinite(min) ? min : 0,
        color, payments: [],
      });
      return d;
    });
    setName(""); setBalance(""); setLimit(""); setApr(""); setMinPayment(""); setOpen(false);
  };

  const delCard = (id) => patch((d) => { d.cards = (d.cards || []).filter((x) => x.id !== id); return d; });

  const addCardToBills = (card, day, accountId) => patch((d) => {
    const billId = uid();
    d.bills.push({
      id: billId, name: `${card.name} (min payment)`, amount: card.minPayment || 0,
      day: Math.min(31, Math.max(1, day || 1)),
      accountId: accountId || d.accounts[0]?.id || "", paidMonth: "",
    });
    const c = (d.cards || []).find((x) => x.id === card.id);
    if (c) c.billId = billId;
    return d;
  });
  const cardLinkedIds = cards.filter((c) => c.billId && bills.some((b) => b.id === c.billId)).map((c) => c.id);

  const payCard = (cardId, amt, accountId) => {
    patch((d) => {
      const c = (d.cards || []).find((x) => x.id === cardId);
      if (c) {
        c.balance = (c.balance || 0) - amt;
        if (!c.payments) c.payments = [];
        c.payments.push({ id: uid(), date: localISO(), amount: amt, accountId });
      }
      const a = d.accounts.find((x) => x.id === accountId);
      if (a) a.balance = balanceOf(a) - amt;
      return d;
    });
  };

  const delPayment = (cardId, pid) => {
    patch((d) => {
      const c = (d.cards || []).find((x) => x.id === cardId);
      const p = c?.payments?.find((x) => x.id === pid);
      if (c && p) {
        c.balance = (c.balance || 0) + p.amount;
        const a = d.accounts.find((x) => x.id === p.accountId);
        if (a) a.balance = balanceOf(a) + p.amount;
        c.payments = c.payments.filter((x) => x.id !== pid);
      }
      return d;
    });
  };

  const totalOwed = cards.reduce((s, c) => s + Math.max(0, c.balance || 0), 0);

  return (
    <div className="space-y-4">
      <SummaryBar label="Owed on cards" value={totalOwed}
        sub={`${cards.length} card${cards.length === 1 ? "" : "s"}`} />

      {open ? (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <Eyebrow>New credit card</Eyebrow>
            {cards.length > 0 && (
              <button onClick={() => setOpen(false)} className="text-slate-400"><X size={18} /></button>
            )}
          </div>
          <div className="space-y-3">
            <Field label="Card name">
              <input className={inputCls} placeholder="e.g. Barclaycard" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Balance owed (£)">
                <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00" value={balance} onChange={(e) => setBalance(e.target.value)} />
              </Field>
              <Field label="Credit limit (£)">
                <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00" value={limit} onChange={(e) => setLimit(e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="APR (%)">
                <input className={inputCls} type="number" inputMode="decimal" placeholder="e.g. 22.9" value={apr} onChange={(e) => setApr(e.target.value)} />
              </Field>
              <Field label="Min payment (£)">
                <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00" value={minPayment} onChange={(e) => setMinPayment(e.target.value)} />
              </Field>
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-slate-500">Colour</span>
              <div className="flex flex-wrap gap-2">
                {ACCOUNT_COLORS.map((col) => (
                  <button key={col} onClick={() => setColor(col)}
                    className={`h-8 w-8 rounded-full transition ${color === col ? "ring-2 ring-slate-900 ring-offset-2" : ""}`}
                    style={{ backgroundColor: col }} />
                ))}
              </div>
            </div>
            <button onClick={addCard} className={`${btnPrimary} w-full`}>
              <Check size={16} /> Save card
            </button>
          </div>
        </Card>
      ) : (
        <button onClick={() => setOpen(true)} className={`${btnPrimary} w-full`}>
          <Plus size={16} /> Add a credit card
        </button>
      )}

      {cards.map((c) => (
        <CardItem key={c.id} card={c} accounts={accounts}
          onPay={payCard} onDelete={delCard} onDeletePayment={delPayment} onEdit={() => setEditing(c)}
          onAddToBills={addCardToBills} linked={cardLinkedIds.includes(c.id)} />
      ))}

      {editing && (
        <EditModal
          title="Edit card"
          item={editing}
          fields={[
            { key: "name", label: "Card name", type: "text" },
            { key: "balance", label: "Balance owed (£)", type: "money" },
            { key: "limit", label: "Credit limit (£)", type: "money" },
            { key: "apr", label: "APR (%)", type: "percent" },
            { key: "minPayment", label: "Min payment (£)", type: "money" },
          ]}
          onClose={() => setEditing(null)}
          onSave={(vals) => {
            patch((d) => {
              const c = (d.cards || []).find((x) => x.id === editing.id);
              if (c) { c.name = vals.name; c.balance = vals.balance; c.limit = vals.limit; c.apr = vals.apr; c.minPayment = vals.minPayment; }
              return d;
            });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function CardItem({ card: c, accounts, onPay, onDelete, onDeletePayment, onEdit, onAddToBills, linked }) {
  const [payOpen, setPayOpen] = useState(false);
  const [payAmt, setPayAmt] = useState(String(c.minPayment || ""));
  const [payFrom, setPayFrom] = useState(accounts[0]?.id || "");
  const [billOpen, setBillOpen] = useState(false);
  const [billDay, setBillDay] = useState("1");
  const [billAcct, setBillAcct] = useState("");

  const owed = Math.max(0, c.balance || 0);
  const inCredit = (c.balance || 0) < 0;
  const limit = c.limit || 0;
  const util = limit > 0 ? (owed / limit) * 100 : 0;
  const available = Math.max(0, limit - owed);
  const overLimit = limit > 0 && owed > limit;

  const m = monthsLeft(owed, c.minPayment, c.apr);
  const term = termLabel(m);

  const doPay = () => {
    const amt = parseFloat(payAmt);
    if (!Number.isFinite(amt) || amt <= 0 || !payFrom) return;
    onPay(c.id, amt, payFrom);
    setPayOpen(false);
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white" style={{ backgroundColor: c.color }}>
            <CreditCard size={17} />
          </span>
          <div className="min-w-0">
            <p className="text-base font-bold text-slate-900">{c.name}</p>
            <p className="text-xs text-slate-400">{c.apr > 0 ? `${c.apr}% APR` : "no APR set"}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <EditBtn onClick={onEdit} />
          <button onClick={() => onDelete(c.id)} className="text-slate-300 hover:text-rose-500">
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between">
        <div>
          <p className="text-xs text-slate-400">{inCredit ? "In credit" : "Balance owed"}</p>
          <p className="text-3xl font-bold tabular-nums text-slate-900">
            {inCredit ? gbp(Math.abs(c.balance)) : gbp(owed)}
          </p>
        </div>
        {limit > 0 && (
          <p className="text-sm font-medium text-slate-500">{gbp0(available)} left of {gbp0(limit)}</p>
        )}
      </div>

      {limit > 0 && (
        <>
          <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-stone-100">
            <div className="h-full rounded-full transition-all"
              style={{ width: `${Math.min(100, util)}%`, backgroundColor: overLimit ? "#e11d48" : util > 75 ? "#d97706" : c.color }} />
          </div>
          <p className={`mt-1.5 text-xs ${overLimit ? "font-medium text-rose-500" : "text-slate-400"}`}>
            {overLimit ? "Over the limit" : `${util.toFixed(0)}% of your limit used`}
          </p>
        </>
      )}

      {c.minPayment > 0 && owed > 0 && (
        <p className="mt-3 rounded-xl bg-stone-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500">
          {m === Infinity ? (
            "At the minimum payment, the interest outpaces it — the balance would barely move."
          ) : (
            <>Paying the {gbp0(c.minPayment)} minimum, it'd take about{" "}
            <span className="font-semibold text-slate-700">{term}</span> to clear, if you stop spending on it.</>
          )}
        </p>
      )}

      {payOpen ? (
        <div className="mt-3 space-y-3 rounded-2xl bg-stone-50 p-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount (£)">
              <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00" value={payAmt} onChange={(e) => setPayAmt(e.target.value)} />
            </Field>
            <Field label="From account">
              <select className={inputCls} value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
                {accounts.length === 0 && <option value="">No accounts</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex gap-2">
            <button onClick={doPay} className={`${btnPrimary} flex-1`} disabled={accounts.length === 0}>
              <Check size={16} /> Make payment
            </button>
            <button onClick={() => setPayOpen(false)} className={btnGhost}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setPayOpen(true)} className={`${btnPrimary} mt-4 w-full`}>
          <ArrowDownCircle size={16} /> Make a payment
        </button>
      )}

      {onAddToBills && c.minPayment > 0 && (
        linked ? (
          <p className="mt-2 text-center text-xs font-medium text-teal-600">✓ Min payment is in your Bills</p>
        ) : billOpen ? (
          <div className="mt-2 space-y-2 rounded-xl border border-stone-200 p-2.5">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-slate-500">Leaves on day</span>
              <input type="number" min="1" max="31" value={billDay} onChange={(e) => setBillDay(e.target.value)}
                className="w-14 rounded-lg border border-stone-200 px-2 py-1 text-center text-sm" />
            </div>
            {accounts.length > 0 && (
              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">Comes out of</span>
                <select value={billAcct} onChange={(e) => setBillAcct(e.target.value)}
                  className="w-full rounded-lg border border-stone-200 px-2 py-1.5 text-sm">
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
            <div className="flex gap-2">
              <button onClick={() => setBillOpen(false)} className="flex-1 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs font-medium text-slate-500">Cancel</button>
              <button onClick={() => { onAddToBills(c, parseInt(billDay) || 1, billAcct || accounts[0]?.id || ""); setBillOpen(false); }}
                className="flex-1 rounded-lg bg-teal-600 px-2.5 py-1.5 text-xs font-semibold text-white">Add to Bills</button>
            </div>
          </div>
        ) : (
          <button onClick={() => { setBillOpen(true); setBillDay("1"); setBillAcct(accounts[0]?.id || ""); }}
            className="mt-2 w-full text-center text-xs font-medium text-teal-600 hover:underline">
            + Add {gbp0(c.minPayment)} min payment to Bills
          </button>
        )
      )}

      {c.payments && c.payments.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-stone-100 pt-3">
          {[...c.payments].reverse().slice(0, 6).map((p) => (
            <li key={p.id} className="flex items-center justify-between text-xs text-slate-500">
              <span>{new Date(p.date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
              <span className="flex items-center gap-2">
                <span className="font-semibold tabular-nums text-teal-700">{gbp(p.amount)}</span>
                <button onClick={() => onDeletePayment(c.id, p.id)} className="text-slate-300 hover:text-rose-500"><X size={13} /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  SETUP                                                              */
/* ------------------------------------------------------------------ */

function Setup({ data, patch, onReset, onExample, onRestore, householdCode, onSignOut }) {
  const [accName, setAccName] = useState("");
  const [accType, setAccType] = useState("Current");
  const [accColor, setAccColor] = useState(ACCOUNT_COLORS[0]);
  const [accBalance, setAccBalance] = useState("");
  const [reserveStr, setReserveStr] = useState(String(data.reserve || ""));
  const [confirmExample, setConfirmExample] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileRef = useRef(null);
  const [restoreMsg, setRestoreMsg] = useState(null);

  const backup = () => {
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const el = document.createElement("a");
      el.href = url;
      el.download = `money-room-backup-${localISO()}.json`;
      document.body.appendChild(el);
      el.click();
      document.body.removeChild(el);
      URL.revokeObjectURL(url);
      setRestoreMsg(null);
    } catch {
      setRestoreMsg("Couldn't make the backup file — try this in a browser tab.");
    }
  };

  const onFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // let the same file be picked again later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad");
        if (!window.confirm("Restore this backup? It replaces everything currently in the app.")) return;
        onRestore(parsed);
        setRestoreMsg("Restored ✓ — check your accounts and bills look right.");
      } catch {
        setRestoreMsg("That file didn't look like a Money Room backup.");
      }
    };
    reader.onerror = () => setRestoreMsg("Couldn't read that file.");
    reader.readAsText(file);
  };
  const [editingAcct, setEditingAcct] = useState(null);
  const [newCat, setNewCat] = useState("");
  const [editingCat, setEditingCat] = useState(null);
  const businessOn = data.businessEnabled !== false;

  const addAccount = () => {
    if (!accName.trim()) return;
    const bal = parseFloat(accBalance);
    patch((d) => {
      d.accounts.push({
        id: uid(), name: accName.trim(), type: accType,
        color: accColor, balance: Number.isFinite(bal) ? bal : 0,
      });
      return d;
    });
    setAccName(""); setAccBalance("");
    setAccColor(ACCOUNT_COLORS[(data.accounts.length + 1) % ACCOUNT_COLORS.length]);
  };

  const setBalance = (id, val) => {
    patch((d) => {
      const a = d.accounts.find((x) => x.id === id);
      if (a) { const n = parseFloat(val); a.balance = Number.isFinite(n) ? n : 0; }
      return d;
    });
  };

  const saveReserve = () => {
    const v = parseFloat(reserveStr);
    patch((d) => { d.reserve = Number.isFinite(v) ? v : 0; return d; });
  };

  const bAcctAdd = (acct) => patch((d) => { d.business.accounts.push(acct); return d; });
  const bAcctDel = (id) => patch((d) => { d.business.accounts = d.business.accounts.filter((x) => x.id !== id); return d; });
  const bAcctBal = (id, val) => patch((d) => {
    const a = d.business.accounts.find((x) => x.id === id);
    if (a) { const n = parseFloat(val); a.balance = Number.isFinite(n) ? n : 0; }
    return d;
  });
  const bAcctEdit = (id, vals) => patch((d) => {
    const a = d.business.accounts.find((x) => x.id === id);
    if (a) { a.name = vals.name; a.type = vals.type; a.balance = vals.balance; a.isTax = vals.isTax; a.overdraft = vals.overdraft; }
    return d;
  });

  const cats = data.categories?.length ? data.categories : CATEGORIES;
  const addCat = () => {
    const name = newCat.trim();
    if (!name) return;
    patch((d) => {
      if (!Array.isArray(d.categories) || !d.categories.length) d.categories = [...CATEGORIES];
      if (!d.categories.some((c) => c.toLowerCase() === name.toLowerCase())) d.categories.push(name);
      return d;
    });
    setNewCat("");
  };
  const removeCat = (name) => patch((d) => {
    if (!Array.isArray(d.categories) || !d.categories.length) d.categories = [...CATEGORIES];
    if (d.categories.length > 1) d.categories = d.categories.filter((c) => c !== name);
    return d;
  });
  const renameCat = (oldName, raw) => {
    const name = (raw || "").trim();
    if (!name) return;
    patch((d) => {
      if (!Array.isArray(d.categories) || !d.categories.length) d.categories = [...CATEGORIES];
      const i = d.categories.indexOf(oldName);
      if (i >= 0 && !d.categories.some((c) => c.toLowerCase() === name.toLowerCase() && c !== oldName)) d.categories[i] = name;
      (d.transactions || []).forEach((t) => { if (t.category === oldName) t.category = name; });
      return d;
    });
  };

  return (
    <div className="space-y-4 lg:columns-2 lg:gap-5 lg:space-y-0 lg:[&>*]:mb-5 lg:[&>*]:break-inside-avoid">
      {/* account */}
      <Card>
        <Eyebrow>Your account</Eyebrow>
        <p className="mb-3 mt-1 text-sm text-slate-500">
          Your data is private to you and synced across your own devices when you sign in.
        </p>
        <button onClick={onSignOut} className={`${btnGhost} mt-3 w-full`}>
          Sign out
        </button>
      </Card>

      {/* business features toggle */}
      <Card>
        <Eyebrow>Business features</Eyebrow>
        <p className="mb-3 mt-1 text-sm text-slate-500">
          Switch this off if you only track personal money. It hides the Income (draws) tab,
          the business side of Debt, and the draw prompts on the home screen. Nothing is deleted —
          flip it back on any time and your business data returns.
        </p>
        <button
          onClick={() => patch((d) => { d.businessEnabled = !businessOn; return d; })}
          className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 transition ${
            businessOn ? "border-teal-200 bg-teal-50" : "border-stone-200 bg-stone-50"
          }`}
        >
          <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <Briefcase size={16} className={businessOn ? "text-teal-600" : "text-slate-400"} />
            Business features {businessOn ? "on" : "off"}
          </span>
          <span className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${
            businessOn ? "justify-end bg-teal-600" : "justify-start bg-stone-300"
          }`}>
            <span className="block h-5 w-5 rounded-full bg-white shadow" />
          </span>
        </button>
      </Card>

      {/* reserve */}
      <Card>
        <Eyebrow>Your safety net</Eyebrow>
        <p className="mb-3 mt-1 text-sm text-slate-500">
          The cushion you want to keep in your personal accounts for day-to-day spending
          and surprises.{businessOn
            ? " The home screen uses this to tell you whether you need to draw more."
            : " The affordability check uses it to warn you before a purchase dips into it."}
        </p>
        <div className="flex gap-2">
          <input className={inputCls} type="number" inputMode="decimal" placeholder="e.g. 800"
            value={reserveStr} onChange={(e) => setReserveStr(e.target.value)} />
          <button onClick={saveReserve} className={btnPrimary}>
            <Check size={16} /> Save
          </button>
        </div>
      </Card>

      {/* personal accounts */}
      <Card>
        <Eyebrow>Your accounts &amp; balances</Eyebrow>
        <p className="mb-3 mt-1 text-sm text-slate-500">
          Pop in what's actually in each account today. Glance at your banking app
          and update these whenever — it keeps "safe to spend" honest.
        </p>

        {data.accounts.length > 0 && (
          <ul className="mb-4 space-y-2">
            {data.accounts.map((a) => (
              <li key={a.id} className="rounded-xl border border-stone-100 p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Dot color={a.color} />
                    <div>
                      <p className="text-sm font-medium text-slate-800">{a.name}</p>
                      <p className="text-xs text-slate-400">
                        {a.type}{a.isTax && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">VAT/tax</span>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <EditBtn onClick={() => setEditingAcct(a)} />
                    <button
                      onClick={() => patch((d) => { d.accounts = d.accounts.filter((x) => x.id !== a.id); return d; })}
                      className="text-slate-300 hover:text-rose-500"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-400">£</span>
                  <input className={inputCls} type="number" inputMode="decimal"
                    value={Number.isFinite(a.balance) ? a.balance : ""}
                    onChange={(e) => setBalance(a.id, e.target.value)} placeholder="Current balance" />
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-3 rounded-2xl bg-stone-50 p-3">
          <Field label="Account name">
            <input className={inputCls} placeholder="e.g. Bills account" value={accName} onChange={(e) => setAccName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select className={inputCls} value={accType} onChange={(e) => setAccType(e.target.value)}>
                {["Current", "Savings", "Credit", "Other"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Balance now (£) — use − if overdrawn">
              <SignedMoneyInput value={accBalance} onChange={(v) => setAccBalance(v)} />
            </Field>
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-slate-500">Colour</span>
            <div className="flex flex-wrap gap-2">
              {ACCOUNT_COLORS.map((c) => (
                <button key={c} onClick={() => setAccColor(c)}
                  className={`h-8 w-8 rounded-full transition ${accColor === c ? "ring-2 ring-slate-900 ring-offset-2" : ""}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
          <button onClick={addAccount} className={`${btnPrimary} w-full`}>
            <Plus size={16} /> Add account
          </button>
        </div>
      </Card>

      {editingAcct && (
        <EditModal
          title="Edit account"
          item={editingAcct}
          fields={[
            { key: "name", label: "Account name", type: "text" },
            { key: "type", label: "Type", type: "select", options: ["Current", "Savings", "Credit", "Other"].map((t) => ({ value: t, label: t })) },
            { key: "balance", label: "Balance now (£) — use − if overdrawn", type: "signedmoney" },
            { key: "overdraft", label: "Overdraft limit (£, if any)", type: "money" },
            { key: "isTax", label: "VAT/tax savings account (kept aside)", type: "toggle" },
          ]}
          onClose={() => setEditingAcct(null)}
          onSave={(vals) => {
            patch((d) => {
              const a = d.accounts.find((x) => x.id === editingAcct.id);
              if (a) { a.name = vals.name; a.type = vals.type; a.balance = vals.balance; a.isTax = vals.isTax; a.overdraft = vals.overdraft; }
              return d;
            });
            setEditingAcct(null);
          }}
        />
      )}

      {businessOn && (
        <BusinessAccounts
          accounts={data.business?.accounts || []}
          onAdd={bAcctAdd}
          onDelete={bAcctDel}
          onBalance={bAcctBal}
          onEdit={bAcctEdit}
        />
      )}

      {/* spending categories */}
      <Card>
        <Eyebrow>Spending categories</Eyebrow>
        <p className="mb-3 mt-1 text-sm text-slate-500">
          The buckets used when you log spending and when the analyser sorts a statement. Make them yours —
          add, rename, or remove. Renaming one updates it on your past spending too.
        </p>
        <ul className="mb-3 space-y-1.5">
          {cats.map((c, i) => (
            <li key={c} className="flex items-center justify-between rounded-xl border border-stone-100 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                <Dot color={CATEGORY_COLOURS[c] || ACCOUNT_COLORS[i % ACCOUNT_COLORS.length]} />
                <span className="truncate">{c}</span>
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <EditBtn onClick={() => setEditingCat(c)} />
                {cats.length > 1 && (
                  <button onClick={() => removeCat(c)} className="text-slate-300 hover:text-rose-500">
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input className={inputCls} placeholder="Add a category…" value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addCat(); }} />
          <button onClick={addCat} className={btnPrimary}><Plus size={16} /></button>
        </div>
      </Card>

      {editingCat && (
        <EditModal
          title="Rename category"
          item={{ name: editingCat }}
          fields={[{ key: "name", label: "Category name", type: "text" }]}
          onClose={() => setEditingCat(null)}
          onSave={(vals) => { renameCat(editingCat, vals.name); setEditingCat(null); }}
        />
      )}

      {/* calendar reminders */}
      <Card>
        <Eyebrow>Bill reminders</Eyebrow>
        <p className="mb-3 mt-1 text-sm text-slate-500">
          Drop your bills into your phone's calendar as monthly reminders — they'll nudge you
          the day before, even when this app is closed.
        </p>
        {data.bills.length === 0 ? (
          <p className="rounded-xl bg-stone-50 px-3 py-4 text-center text-sm text-slate-400">
            Add some bills first, then you can export them here.
          </p>
        ) : (
          <>
            <a
              href={`data:text/calendar;charset=utf-8,${encodeURIComponent(icsForBills(data.bills))}`}
              download="money-room-bills.ics"
              className={`${btnPrimary} w-full no-underline`}
            >
              <CalendarClock size={16} /> Download calendar reminders
            </a>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              Open the downloaded file to add all {data.bills.length} bills to your calendar.
              Anything due after the 28th reminds on the 28th, so no month gets skipped.
            </p>
          </>
        )}
      </Card>

      {/* data */}
      <Card>
        <Eyebrow>Your data</Eyebrow>
        <p className="mb-3 mt-1 text-sm text-slate-500">
          Everything is saved privately to this app, just for you — it stays between sessions.
        </p>
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={backup} className={btnGhost}>
              <ArrowDownCircle size={15} /> Back up
            </button>
            <button onClick={() => fileRef.current && fileRef.current.click()} className={btnGhost}>
              <Upload size={15} /> Restore
            </button>
          </div>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} className="hidden" />
          {restoreMsg && <p className="text-xs text-slate-500">{restoreMsg}</p>}
          <p className="text-xs text-slate-400">
            Back up saves a file with all your data; Restore loads one back in. Best done in a browser tab.
          </p>
          <div className="my-1 border-t border-stone-100" />
          {confirmExample ? (
            <div className="rounded-xl border border-stone-200 p-3">
              <p className="mb-2 text-sm text-slate-600">Replace everything with the example setup?</p>
              <div className="flex gap-2">
                <button onClick={() => { setConfirmExample(false); onExample(); }} className={`${btnPrimary} flex-1`}>
                  Yes, load it
                </button>
                <button onClick={() => setConfirmExample(false)} className={btnGhost}>Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setConfirmExample(true)} className={btnGhost}>Load example setup</button>
          )}

          {confirmClear ? (
            <div className="rounded-xl border border-rose-200 p-3">
              <p className="mb-2 text-sm text-slate-600">Clear everything — personal and business? This can't be undone.</p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setConfirmClear(false); onReset(); }}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-rose-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-rose-700"
                >
                  Yes, clear it
                </button>
                <button onClick={() => setConfirmClear(false)} className={btnGhost}>Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50"
            >
              <Trash2 size={15} /> Clear everything
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared summary bar                                                 */
/* ------------------------------------------------------------------ */

function SummaryBar({ label, value, sub }) {
  return (
    <div className="flex items-end justify-between rounded-3xl border border-stone-200 bg-white px-5 py-4 shadow-sm">
      <div>
        <Eyebrow>{label}</Eyebrow>
        {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
      </div>
      <p className="text-2xl font-bold tabular-nums text-slate-900">{gbp(value)}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SUPABASE WRAPPER — auth, household, live sync                      */
/* ------------------------------------------------------------------ */

function normalizeData(parsed) {
  const p = parsed || {};
  const merged = { ...EMPTY, ...p };
  merged.business = { accounts: [], loans: [], bills: [], ...(p.business || {}) };
  if (!Array.isArray(merged.business.accounts)) merged.business.accounts = [];
  if (!Array.isArray(merged.business.loans)) merged.business.loans = [];
  if (!Array.isArray(merged.business.bills)) merged.business.bills = [];
  if (!Array.isArray(merged.accounts)) merged.accounts = [];
  if (!Array.isArray(merged.bills)) merged.bills = [];
  if (!Array.isArray(merged.transactions)) merged.transactions = [];
  if (!Array.isArray(merged.loans)) merged.loans = [];
  if (!Array.isArray(merged.draws)) merged.draws = [];
  if (!Array.isArray(merged.cards)) merged.cards = [];
  if (!Array.isArray(merged.pots)) merged.pots = [];
  if (!Array.isArray(merged.categories) || merged.categories.length === 0) merged.categories = [...CATEGORIES];
  if (!Number.isFinite(merged.reserve)) merged.reserve = 0;
  if (typeof merged.businessEnabled !== "boolean") merged.businessEnabled = true;
  return merged;
}

function Splash({ label }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 text-slate-400">
      {label || "Loading…"}
    </div>
  );
}

function Auth() {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [showPw, setShowPw] = useState(false);

  const submit = async () => {
    const mail = email.trim();
    if (!mail || !password) { setError("Enter your email and password."); return; }
    if (password.length < 6) { setError("Password needs to be at least 6 characters."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: mail, password });
        if (error) throw error;
        // With "Confirm email" off, a session comes back and the auth listener
        // takes over. If confirmation is still on, there's no session yet.
        if (!data.session) {
          setNotice("Account created. If sign-in says the details are wrong, 'Confirm email' is still switched on in Supabase — turn it off, then sign in.");
          setMode("signin");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: mail, password });
        if (error) throw error;
      }
    } catch (e) {
      const msg = e?.message || "";
      if (/already registered/i.test(msg)) setError("That email's already set up — switch to Sign in below and use that password.");
      else if (/email not confirmed/i.test(msg)) setError("This account hasn't been confirmed. Turn off 'Confirm email' in Supabase, or use the confirmation link in your inbox.");
      else if (/invalid login credentials/i.test(msg)) setError("Email or password isn't right. Tap the eye to check what you typed. If you'd used this email here before, the old account may need deleting in Supabase first.");
      else setError(msg || "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e) => { if (e.key === "Enter") submit(); };

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-600 text-white">
            <Wallet size={26} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">The Money Room</h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === "signup" ? "Create your account to get started." : "Welcome back — sign in to continue."}
          </p>
        </div>
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="space-y-3">
            <Field label="Email">
              <input className={inputCls} type="email" inputMode="email" autoComplete="email"
                placeholder="you@email.com"
                value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={onKey} />
            </Field>
            <Field label="Password">
              <div className="relative">
                <input className={`${inputCls} pr-11`} type={showPw ? "text" : "password"}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
                  value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={onKey} />
                <button type="button" onClick={() => setShowPw((s) => !s)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-400 transition hover:text-slate-600">
                  {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </Field>
            {error && <p className="text-sm text-rose-600">{error}</p>}
            {notice && <p className="text-sm text-teal-600">{notice}</p>}
            <button onClick={submit} disabled={busy} className={`${btnPrimary} w-full`}>
              {busy ? "Just a sec…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </div>
          <div className="mt-4 text-center text-sm text-slate-500">
            {mode === "signup" ? "Already have an account?" : "First time here?"}{" "}
            <button type="button"
              onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(null); setNotice(null); }}
              className="font-medium text-teal-600 hover:text-teal-700">
              {mode === "signup" ? "Sign in" : "Create an account"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Onboarding() {
  const startedRef = useRef(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      const { error } = await supabase.rpc("create_household");
      if (error) setError(error.message);
      else window.location.reload();
    })();
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-50 px-4">
        <div className="w-full max-w-sm rounded-3xl border border-stone-200 bg-white p-5 text-center shadow-sm">
          <p className="text-sm font-medium text-slate-800">Couldn't finish setting up</p>
          <p className="mt-1 text-sm text-rose-600">{error}</p>
          <button onClick={() => window.location.reload()} className={`${btnPrimary} mt-4 w-full`}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  return <Splash label="Setting up your account…" />;
}

function useHousehold(session) {
  const [data, setLocal] = useState(EMPTY);
  const [householdId, setHouseholdId] = useState(null);
  const [householdCode, setHouseholdCode] = useState("");
  const [joinNeeded, setJoinNeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const saveTimer = useRef(null);
  const skipNext = useRef(false);

  useEffect(() => {
    if (!session) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: prof } = await supabase
        .from("profiles").select("household_id").eq("id", session.user.id).single();
      const hid = prof && prof.household_id ? prof.household_id : null;
      if (!hid) { if (!cancelled) { setJoinNeeded(true); setLoading(false); } return; }
      const { data: hh } = await supabase
        .from("households").select("data, join_code").eq("id", hid).single();
      if (cancelled) return;
      setHouseholdId(hid);
      setHouseholdCode(hh && hh.join_code ? hh.join_code : "");
      setLocal(normalizeData(hh ? hh.data : {}));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session]);

  useEffect(() => {
    if (!householdId) return;
    const ch = supabase
      .channel("hh-" + householdId)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "households", filter: `id=eq.${householdId}` },
        (payload) => {
          if (skipNext.current) { skipNext.current = false; return; }
          if (payload.new && payload.new.data) setLocal(normalizeData(payload.new.data));
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [householdId]);

  const setData = useCallback((updater) => {
    setLocal((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (householdId) {
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(async () => {
          skipNext.current = true;
          await supabase.from("households")
            .update({ data: next, updated_at: new Date().toISOString() })
            .eq("id", householdId);
        }, 700);
      }
      return next;
    });
  }, [householdId]);

  return { data, setData, loading, householdId, householdCode, joinNeeded };
}

export default function App() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const hh = useHousehold(session);

  if (authLoading) return <Splash label="Starting up…" />;
  if (!session) return <Auth />;
  if (hh.joinNeeded) return <Onboarding />;
  if (hh.loading) return <Splash label="Loading your money…" />;

  return (
    <MoneyApp
      data={hh.data}
      setData={hh.setData}
      loading={false}
      householdCode={hh.householdCode}
      onSignOut={() => supabase.auth.signOut()}
    />
  );
}
