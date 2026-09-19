// mock.mjs — the offline stand-in reader for Jev Sheets.
//
// Without a TYPESAFE_API_KEY the sheet still has to fill, so this file gives evaluate() a domain
// reader. It sees exactly what live Jev would see: the row (as the state text) and the question
// (the header wording, the option names and descriptions, the level names). It never sees truth
// labels, row groups or anything else from the sheet.
//
// How it reads: a small lexicon maps the words of a question to cue words and phrases. Evidence is
// how many cues the row text contains. One clear signal gives a confident answer. Mixed signals, or
// no signal at all, give a flat distribution and a low confidence. So ambiguity in the text is the
// only thing that lowers confidence. It is a stand-in for plumbing, not for Jev's judgement.
import { hash01 } from '../toolchain/jev.mjs'

const STOP = new Set('a an the of to in on at for and or is are was were be been it its this that these those with as by from not no yes do does did has have had will would can could should may might if then than so such very more most less least about into over under out up down off any all each every some which who whom what when where why how i you he she we they them his her our your their my me us'.split(' '))
// Words too common in questions to count as evidence when they also show up in a row.
const GENERIC = new Set('problem issue question customer user thing help need want other anything else general message request related row text person people someone something kind type best fit pick rate level scale mention mentions asking asks wants ask about contain contains'.split(' ').map(root))

/** Crude word root, applied to both sides of every comparison so "charged" meets "charges". */
export function root(w) {
  for (let pass = 0; pass < 2; pass++) {
    if (w.length > 4) {
      const n = w.replace(/(ingly|edly|ings|ing|ies|ied|ely|ed|es|ly|s|e|y)$/, '')
      if (n === w || n.length < 3) break
      w = n
    } else if (w.length === 4 && /[sey]$/.test(w) && !w.endsWith('ss')) { w = w.slice(0, 3); break } else break
  }
  return w
}

const words = (text) => String(text).toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9$%]+/).filter(Boolean)
const needleRoots = (text) => [...new Set(words(text).filter((w) => w.length > 1 && !STOP.has(w)).map(root).filter((r) => !GENERIC.has(r)))]

// ---------------------------------------------------------------------------
// The lexicon. keys: words in a QUESTION that switch the concept on. mild / strong: cues in a ROW
// (weight 1 / 2). anti: cues that argue the other way. Polar concepts have pos / neg ends instead.
// Cues starting with "#" are text features: #bang2 (two or more "!"), #caps (shouted words),
// #qmark (a question mark), #mid / #big (a head count of 20+ / 100+).
// ---------------------------------------------------------------------------
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean)
const cue = (c, w) => (c.startsWith('#') ? { key: c, feat: c, w, roots: [] }
  : c.includes(' ') ? { key: c, phrase: ` ${words(c).join(' ')} `, w, roots: words(c).filter((x) => !STOP.has(x)).map(root) }
  : { key: root(c), word: root(c), w, roots: [root(c)] })
const concept = (id, o) => ({
  id,
  keys: new Set(list(o.keys).flatMap((k) => words(k)).map(root)),
  cues: [...list(o.mild ?? '').map((c) => cue(c, 1)), ...list(o.strong ?? '').map((c) => cue(c, 2))],
  anti: list(o.anti ?? '').map((c) => cue(c, 1)),
  pos: list(o.pos ?? '').map((c) => cue(c, 1)),
  neg: list(o.neg ?? '').map((c) => cue(c, 1)),
  polar: !!o.pos,
})

const POSITIVE = 'thanks, thank, love, loving, great, awesome, amazing, excellent, happy, appreciate, fantastic, perfect, well done, helpful, impressed, brilliant, saved us, smooth, pleased, wonderful, kudos, delighted, best, flawless'
const NEGATIVE = 'annoying, annoyed, frustrating, frustrated, disappointed, disappointing, unhappy, not happy, fed up, unacceptable, outrageous, ridiculous, worst, terrible, awful, useless, broken, hate, poor, worse, furious, sick of, let down, garbage, pathetic, nightmare, #bang2'

const LEX = [
  concept('urgency', {
    keys: 'urgent, urgency, asap, priority, critical, emergency, rush, immediately, deadline, time sensitive, pressing, hurry, today',
    mild: 'deadline, end of day, by tomorrow, by friday, by monday, this week, blocked, hurry, quickly, time sensitive, cant work, cannot work, as soon as, tonight, within the hour, before the launch, clock is ticking, today',
    strong: 'urgent, urgently, asap, immediately, emergency, critical, right now, right away, outage, is down, are down, went down, losing money, losing data, losing customers, every minute, every hour, production',
    anti: 'no rush, not urgent, no hurry, whenever, when you get a chance, low priority, next quarter, next month, next year, sometime, at some point, just curious, no deadline, eventually, take your time, nothing pressing',
  }),
  concept('anger', {
    keys: 'anger, angry, furious, upset, frustration, frustrated, annoyed, mad, rage, irritated, temper, hostile, livid',
    mild: 'annoying, annoyed, frustrating, frustrated, disappointed, disappointing, not happy, unhappy, third time, second time, fed up, irritating, yet again, getting old, let down, not impressed, tiresome, not good enough',
    strong: 'furious, unacceptable, outrageous, ridiculous, worst, disgrace, scam, rip off, ripoff, incompetent, useless, sick of, livid, how dare, pathetic, garbage, terrible, awful, nightmare, #bang3, #caps',
    anti: 'appreciate, no worries, cheers, love, great work, thank you so much, thanks so much, no complaints, all good',
  }),
  concept('billing', {
    keys: 'billing, bill, payment, payments, invoice, invoices, charge, charges, finance, accounting, accounts',
    mild: 'invoice, charged, charge, billing, billed, bill, payment, card, receipt, refund, charged twice, double charged, vat, tax, renewal, credit card, overcharged, debit, bank statement, billing cycle, payment failed, declined, prorated, purchase order number',
  }),
  concept('tech', {
    keys: 'tech, technical, bug, bugs, engineering, outage, outages, error, errors, defect, incident, crash, failure, failures',
    mild: 'bug, error, errors, crash, crashes, crashing, crashed, not working, doesnt work, stopped working, sync, syncing, upload, uploads, uploading, timeout, times out, outage, is down, went down, error code, freeze, freezes, frozen, glitch, reinstall, reinstalled, latest version, update broke, api, corrupted, stack trace, logs, desktop app, mobile app',
  }),
  concept('sales', {
    keys: 'sales, sale, pricing, purchase, buy, buying, deal, lead, prospect, commercial, upgrade, upgrades, upsell, expansion, quote, quotes, demo, demos',
    mild: 'pricing, price, quote, demo, trial, upgrade, upgrading, seats, licenses, licences, enterprise plan, team plan, discount, purchase, buy, buying, procurement, volume, sales team, talk to sales, how much, per user, evaluating, proof of concept, rollout, annual plan, reseller, partnership, nonprofit',
  }),
  concept('refund', {
    keys: 'refund, refunds, reimburse, reimbursement, money back, chargeback',
    mild: 'reimburse, reimbursement, credit back, reverse the charge',
    strong: 'refund, refunded, money back, chargeback, charge back, return my money, want my money',
  }),
  concept('churn', {
    keys: 'churn, cancel, cancellation, leave, leaving, retention, attrition, quit, lose, losing',
    mild: 'cancel, cancelling, canceling, cancellation, alternatives, reconsider, not renew, not renewing, downgrade, downgrading, thinking of leaving, other options, might switch, considering switching, shopping around, last chance',
    strong: 'cancel my, cancel our, cancel immediately, close my account, close our account, delete my account, switching to, moving to, done with, last straw, we are leaving, taking our business',
    anti: 'renewed, happy customer, love the product, more seats, add seats, upgrade, upgrading, signing up, long term',
  }),
  concept('sentiment', { keys: 'sentiment, mood, satisfaction, satisfied, happiness, feeling, csat, nps, attitude, tone', pos: POSITIVE, neg: NEGATIVE }),
  concept('polite', { keys: 'polite, politeness, courtesy, courteous, rude, rudeness, respectful, civility, manners', pos: 'please, thanks, thank, kindly, appreciate, best regards, kind regards, sorry, cheers, grateful', neg: 'unacceptable, ridiculous, useless, incompetent, pathetic, garbage, how dare, sick of, #bang3, #caps' }),
  concept('positive', { keys: 'positive, happy, praise, compliment, delighted, pleased, good, promoter, thanks, thank, kudos, testimonial, fan', mild: POSITIVE }),
  concept('negative', { keys: 'negative, unhappy, complaint, complaints, complain, complaining, dissatisfied, bad, detractor, critical feedback', mild: NEGATIVE }),
  concept('spam', {
    keys: 'spam, junk, phishing, unsolicited, promotion, promotional, marketing, outreach, solicitation, cold',
    mild: 'seo, guest post, backlinks, link building, crypto, bitcoin, lottery, click here, limited offer, act now, unsubscribe, dear sir, investment opportunity, rank your website, web design services, lead generation, we offer, boost your, 10x your',
  }),
  concept('feature', {
    keys: 'feature, features, idea, ideas, suggestion, suggestions, enhancement, roadmap, wishlist',
    mild: 'feature, would be great, would love, wish, suggestion, suggest, could you add, please add, any plans, roadmap, feature request, idea, it would help, support for, dark mode, integration, integrate, nice to have',
  }),
  concept('security', {
    keys: 'security, secure, privacy, breach, vulnerability, vulnerabilities, hacked',
    mild: 'security, breach, hacked, compromised, unauthorized, unauthorised, suspicious, phishing, password, 2fa, two factor, sso, encryption, encrypted, vulnerability, pen test, soc 2, soc2, leaked, unknown device, login from',
  }),
  concept('legal', {
    keys: 'legal, compliance, contract, contracts, gdpr, regulatory, lawyer, law, dpa',
    mild: 'legal, lawyer, lawyers, attorney, gdpr, dpa, data processing, compliance, terms of service, contract, nda, lawsuit, sue, liability, regulator, audit, hipaa, msa',
  }),
  concept('size', {
    keys: 'vip, enterprise, size, big, large, value, valuable, important, tier, revenue, whale, potential',
    mild: 'team, seats, company, department, our users, employees, across the, organisation, organization, offices, #mid',
    strong: 'enterprise, hundreds, thousand, thousands, company wide, all offices, global, annual contract, procurement, #big',
    anti: 'just me, personal, hobby, student, free plan, solo, freelancer',
  }),
  concept('question', {
    keys: 'question, questions, inquiry, enquiry, howto, how to, curious',
    mild: 'how do i, how can, is it possible, can you, could you, where do, what is, wondering, does it, is there, #qmark',
  }),
  concept('escalate', {
    keys: 'manager, supervisor, escalate, escalation, human, call, phone, callback, boss',
    mild: 'manager, supervisor, escalate, escalation, speak to, talk to someone, call me, phone call, a real person, a human, someone senior, your boss, ceo, in charge',
  }),
  concept('competitor', {
    keys: 'competitor, competitors, competition, alternative, alternatives, rival, rivals, switch, switching',
    mild: 'competitor, competitors, switching to, switch to, moving to, alternative, alternatives, other vendors, another provider, other providers, compared to, cheaper elsewhere, other options, shopping around',
  }),
  concept('access', {
    keys: 'login, account, access, password, authentication, onboarding, signin, sign in',
    mild: 'login, log in, sign in, password, reset link, locked out, cant access, cannot access, two factor, 2fa, sso, verification email, invite, permissions, admin',
  }),
  concept('files', {
    keys: 'sync, syncing, backup, backups, upload, storage, files, file, restore',
    mild: 'sync, syncing, synced, upload, uploads, download, backup, backups, restore, version history, folder, folders, files, storage, quota, shared drive, conflict copies',
  }),
  concept('severity', {
    keys: 'severity, impact, severe, serious, damage, blast radius',
    mild: 'slow, some users, intermittent, sometimes, several users, error, crash, not working',
    strong: 'data loss, lost files, all users, everyone, whole team, entire company, outage, is down, corrupted, cannot work, cant work, production, deleted, gone',
    anti: 'workaround, minor, cosmetic, typo, small thing',
  }),
]

const HIGH_WORDS = new Set('high severe critical extreme strong very hot max maximum most furious huge'.split(' '))
const LOW_WORDS = new Set('low none mild calm cold min minimum least minor tiny'.split(' '))

// ---------------------------------------------------------------------------
// Reading a row
// ---------------------------------------------------------------------------
function readRow(stateText) {
  let text = String(stateText ?? '')
  try {
    const o = JSON.parse(text)
    if (o && typeof o === 'object') text = Object.values(o).filter((v) => typeof v === 'string' || typeof v === 'number').join(' \n ')
  } catch { /* plain text state */ }
  const toks = words(text)
  let head = 0
  for (const m of text.matchAll(/(\d{2,6})\s+(seats|users|people|employees|licen[cs]es|staff|engineers|teammates|accounts)/gi)) head = Math.max(head, Number(m[1]))
  return {
    text,
    roots: new Set(toks.filter((w) => !STOP.has(w)).map(root)),
    norm: ` ${toks.join(' ')} `,
    bangs: (text.match(/!/g) || []).length,
    caps: (text.match(/\b[A-Z]{4,}\b/g) || []).length,
    qmarks: (text.match(/\?/g) || []).length,
    head,
  }
}

function hit(T, c) {
  if (c.feat) {
    if (c.feat === '#bang2') return T.bangs >= 2
    if (c.feat === '#bang3') return T.bangs >= 3
    if (c.feat === '#caps') return T.caps >= 2
    if (c.feat === '#qmark') return T.qmarks >= 1
    if (c.feat === '#mid') return T.head >= 20 && T.head < 100
    if (c.feat === '#big') return T.head >= 100
    return false
  }
  return c.phrase ? T.norm.includes(c.phrase) : T.roots.has(c.word)
}

/** Evidence in row T for a piece of question wording (a header, an option + description, a level). */
function evidence(T, wording) {
  const need = needleRoots(wording)
  const active = LEX.filter((c) => need.some((r) => c.keys.has(r)))
  const seen = new Set(), blocked = new Set()
  let w = 0, anti = 0, pos = 0, neg = 0, polar = false
  // "not urgent" argues against urgency, and its word "urgent" must not also count for it.
  for (const c of active) for (const q of c.anti) if (hit(T, q)) { anti += q.w; for (const r of q.roots) blocked.add(r) }
  for (const c of active) {
    if (c.polar) {
      polar = true
      for (const q of c.pos) if (hit(T, q)) pos += q.w
      for (const q of c.neg) if (hit(T, q)) neg += q.w
      continue
    }
    for (const q of c.cues) if (!seen.has(q.key) && !(q.word && blocked.has(q.word)) && hit(T, q)) { seen.add(q.key); w += q.w }
  }
  // Plain wording overlap: the row uses the same word as the question or the option.
  for (const r of need) if (!seen.has(r) && !blocked.has(r) && T.roots.has(r)) { seen.add(r); w += 1 }
  return { w, anti, pos, neg, known: active.length > 0, polar }
}

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x))
const sat = (e, k = 1.6) => 1 - Math.exp(-Math.max(0, e) / k)

function softmax(raw) {
  const m = Math.max(...raw)
  const ex = raw.map((r) => Math.exp(r - m))
  const s = ex.reduce((a, b) => a + b, 0)
  return ex.map((e) => e / s)
}

/** Never one-hot: keep a little mass on every option, like a calibrated model does. */
function soften(probs, floor = 0.03) {
  const n = probs.length
  return probs.map((p) => p * (1 - floor) + floor / n)
}

function gaussian(n, pos, sigma) {
  const raw = Array.from({ length: n }, (_, i) => -((i - pos) ** 2) / (2 * sigma * sigma))
  return soften(softmax(raw))
}

const OTHER = /^(other|others|none|neither|general|misc|unknown|unclear|n\/a|something else)$/i

/**
 * The domain reader handed to evaluate() as `mock`.
 * @param {(qid:string)=>object|undefined} lookup  column definition for a question id
 */
export function sheetMock(lookup) {
  return function mock(stateText, qid, q, salt) {
    const col = lookup(qid)
    if (!col) return null
    const T = readRow(stateText)
    const jit = (key, amp) => (hash01(`${qid}::${key}::${T.text.slice(0, 96)}::${T.text.length}`, salt) - 0.5) * amp

    if (col.type === 'noul') {
      const ev = evidence(T, col.header)
      let logit
      if (ev.polar && !ev.w) logit = (ev.pos - ev.neg) * 1.1
      else if (!ev.known && !ev.w) logit = -0.75 // the stand-in does not know this question: lean no, unsure
      else logit = -1.7 + 4.6 * sat(ev.w) - 1.9 * sat(ev.anti, 1)
      const p = clamp(1 / (1 + Math.exp(-(logit + jit('noul', 0.5)))), 0.03, 0.97)
      return { type: 'noul', noul: p }
    }

    if (col.type === 'choice') {
      const evs = col.options.map((opt) => evidence(T, `${opt.replace(/[_-]+/g, ' ')} ${col.descriptions?.[opt] ?? ''}`))
      const strength = evs.map((e) => Math.max(0, e.w + e.pos - 0.8 * (e.anti + e.neg)))
      const best = Math.max(...strength)
      const raw = col.options.map((opt, i) => {
        const base = OTHER.test(opt) && best === 0 ? 1.2 : strength[i]
        return 3.2 * sat(base) + jit(`o${i}`, 0.36)
      })
      const probs = soften(softmax(raw))
      const bi = probs.indexOf(Math.max(...probs))
      const probabilities = {}
      col.options.forEach((opt, i) => (probabilities[opt] = probs[i]))
      return { type: 'choice', choice: col.options[bi], confidence: probs[bi], probabilities }
    }

    if (col.type === 'score') {
      const n = col.levels.length
      const first = words(col.levels[0]), last = words(col.levels[n - 1])
      const nameEv = evidence(T, col.name)
      let reversed = first.some((w) => HIGH_WORDS.has(w)) || last.some((w) => LOW_WORDS.has(w))
      let pos, sigma = 0.45

      if (nameEv.polar) {
        // A two-ended scale (sentiment, politeness): cues pull to either end, the middle is "neither".
        const mid = (n - 1) / 2
        if (needleRoots(col.levels[0]).some((r) => LEX.find((c) => c.id === 'positive').keys.has(r))) reversed = true
        pos = mid + clamp((nameEv.pos - nameEv.neg) / 3, -1, 1) * mid
        if (nameEv.pos && nameEv.neg) sigma = 0.85
      } else if (nameEv.known) {
        // A one-ended scale (urgency, anger, churn risk): more and stronger cues push it higher.
        const eff = Math.max(0, nameEv.w - 1.2 * nameEv.anti)
        pos = Math.min(1, eff / 4) ** 0.85 * (n - 1)
        if (nameEv.w && nameEv.anti) sigma = 0.85
      } else {
        // The name means nothing to the stand-in. Try the level names themselves.
        const evs = col.levels.map((l) => evidence(T, l))
        const strength = evs.map((e) => Math.max(0, e.w - 0.8 * e.anti))
        if (Math.max(...strength) > 0) {
          const probs = soften(softmax(strength.map((s, i) => 3.2 * sat(s) + jit(`l${i}`, 0.3))))
          return scoreAnswer(col, probs)
        }
        pos = hash01(`${qid}::${T.text.slice(0, 120)}`, salt) * (n - 1)
        sigma = 1.15 // no idea: a flat, low-confidence guess
      }
      pos = clamp(pos + jit('pos', 0.2), 0, n - 1)
      if (reversed) pos = n - 1 - pos
      return scoreAnswer(col, gaussian(n, pos, sigma))
    }
    return null
  }
}

function scoreAnswer(col, probs) {
  const probabilities = {}
  probs.forEach((p, i) => (probabilities[String(i)] = p))
  const legend = Object.fromEntries(col.levels.map((l, i) => [String(i), l]))
  return { type: 'score', score: probs.reduce((a, p, i) => a + p * i, 0), confidence: Math.max(...probs), legend, probabilities }
}
