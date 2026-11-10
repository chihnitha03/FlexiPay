"""Build the FlexPrice AI pitch deck (16:9) with python-pptx.

    python3 presentation/build_deck.py   →   presentation/FlexPrice-AI.pptx

Every number in this deck comes from the running codebase (tests, benchmarks, simulator).
"""

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

HERE = Path(__file__).parent
ASSETS = HERE / "assets"
OUT = HERE / "FlexPrice-AI.pptx"

# ---- design tokens -------------------------------------------------------------------------
NAVY = RGBColor(0x0B, 0x1B, 0x3F)
BLUE = RGBColor(0x00, 0x70, 0xE0)
INK = RGBColor(0x10, 0x18, 0x28)
BODY = RGBColor(0x34, 0x40, 0x54)
MUTED = RGBColor(0x66, 0x70, 0x85)
LINE = RGBColor(0xE4, 0xE7, 0xEC)
SOFT = RGBColor(0xF6, 0xF8, 0xFB)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
SKY = RGBColor(0x7C, 0xC4, 0xFF)
PURPLE = RGBColor(0x69, 0x41, 0xC6)
PURPLE_BG = RGBColor(0xF4, 0xEB, 0xFF)
AMBER = RGBColor(0xB5, 0x47, 0x08)
AMBER_BG = RGBColor(0xFF, 0xF8, 0xE6)
GREEN = RGBColor(0x06, 0x76, 0x47)
GREEN_BG = RGBColor(0xEC, 0xFD, 0xF3)
RED = RGBColor(0xB4, 0x23, 0x18)
BLUE_BG = RGBColor(0xEE, 0xF4, 0xFF)
PP_BLUE = RGBColor(0x00, 0x30, 0x87)
PP_SKY = RGBColor(0x00, 0x9C, 0xDE)
FONT = "Arial"

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]
SW, SH = prs.slide_width, prs.slide_height
MARGIN = Inches(0.6)
state = {"n": 0}


# ---- primitives ----------------------------------------------------------------------------
def _runs(p, parts, size, color, bold=False):
    """parts: str or list of (text, {bold, color, size, italic})"""
    if isinstance(parts, str):
        parts = [(parts, {})]
    for text, fmt in parts:
        r = p.add_run()
        r.text = text
        f = r.font
        f.name = FONT
        f.size = Pt(fmt.get("size", size))
        f.bold = fmt.get("bold", bold)
        f.italic = fmt.get("italic", False)
        f.color.rgb = fmt.get("color", color)


def text(slide, x, y, w, h, paras, size=16, color=BODY, bold=False, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, spacing=1.12, space_after=6, bullet=False):
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = Inches(0.02)
    tf.margin_top = tf.margin_bottom = Inches(0.02)
    tf.vertical_anchor = anchor
    if isinstance(paras, (str, tuple)):
        paras = [paras]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = spacing
        p.space_after = Pt(space_after)
        content = para
        if bullet:
            content = [("•  ", {"color": BLUE, "bold": True})] + (para if isinstance(para, list) else [(para, {})])
        _runs(p, content, size, color, bold)
    return tb


def box(slide, x, y, w, h, fill=WHITE, line=LINE, radius=True, line_w=1.0, shadow=False):
    shp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE, x, y, w, h)
    if radius:
        shp.adjustments[0] = 0.08 if min(w, h) > Inches(1.2) else 0.18
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill
    if line is None:
        shp.line.fill.background()
    else:
        shp.line.color.rgb = line
        shp.line.width = Pt(line_w)
    if not shadow:
        shp.shadow.inherit = False
    shp.text_frame.text = ""
    return shp


def card(slide, x, y, w, h, title, lines, fill=WHITE, line=LINE, title_color=INK, size=13, title_size=16, tag=None, tag_color=BLUE, bullet=True):
    box(slide, x, y, w, h, fill=fill, line=line)
    pad = Inches(0.22)
    ty = y + pad
    if tag:
        pill(slide, x + pad, ty, tag, color=tag_color)
        ty += Inches(0.42)
    text(slide, x + pad, ty, w - 2 * pad, Inches(0.5), [[(title, {"bold": True})]], size=title_size, color=title_color)
    text(slide, x + pad, ty + Inches(0.48), w - 2 * pad, h - (ty - y) - Inches(0.6), lines, size=size, color=BODY, bullet=bullet, space_after=5)


def pill(slide, x, y, label, color=BLUE, fill=None, size=10.5):
    w = Inches(0.3 + 0.095 * len(label))
    shp = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, Inches(0.3))
    shp.adjustments[0] = 0.5
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill or WHITE
    shp.line.color.rgb = color
    shp.line.width = Pt(1)
    shp.shadow.inherit = False
    tf = shp.text_frame
    tf.margin_left = tf.margin_right = Inches(0.06)
    tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    _runs(p, label, size, color, bold=True)
    return shp


def arrow(slide, x, y, w=Inches(0.35), h=Inches(0.3), color=MUTED):
    shp = slide.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW, x, y, w, h)
    shp.fill.solid()
    shp.fill.fore_color.rgb = color
    shp.line.fill.background()
    shp.shadow.inherit = False
    return shp


def down_arrow(slide, x, y, w=Inches(0.3), h=Inches(0.3), color=MUTED):
    shp = slide.shapes.add_shape(MSO_SHAPE.DOWN_ARROW, x, y, w, h)
    shp.fill.solid()
    shp.fill.fore_color.rgb = color
    shp.line.fill.background()
    shp.shadow.inherit = False
    return shp


def stat(slide, x, y, w, value, label, color=NAVY, value_size=30, label_size=12):
    text(slide, x, y, w, Inches(0.6), [[(value, {"bold": True})]], size=value_size, color=color, space_after=0)
    text(slide, x, y + Inches(0.62), w, Inches(0.7), label, size=label_size, color=MUTED, spacing=1.05)


def table(slide, x, y, w, rows, col_w, header_fill=NAVY, size=12, row_h=Inches(0.42), first_col_bold=True, zebra=True):
    shp = slide.shapes.add_table(len(rows), len(rows[0]), x, y, w, row_h * len(rows))
    tbl = shp.table
    for i, cw in enumerate(col_w):
        tbl.columns[i].width = cw
    for r, row in enumerate(rows):
        tbl.rows[r].height = row_h
        for c, val in enumerate(row):
            cell = tbl.cell(r, c)
            cell.margin_left = cell.margin_right = Inches(0.1)
            cell.margin_top = cell.margin_bottom = Inches(0.04)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            cell.fill.solid()
            if r == 0:
                cell.fill.fore_color.rgb = header_fill
            else:
                cell.fill.fore_color.rgb = SOFT if (zebra and r % 2 == 0) else WHITE
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            parts = val if isinstance(val, list) else [(str(val), {})]
            _runs(p, parts, size, WHITE if r == 0 else (INK if c == 0 else BODY), bold=(r == 0) or (c == 0 and first_col_bold))
    return tbl


def image(slide, path, x, y, w=None, h=None, border=True):
    pic = slide.shapes.add_picture(str(path), x, y, width=w, height=h)
    if border:
        pic.line.color.rgb = LINE
        pic.line.width = Pt(1)
    return pic


def new_slide(section, title, subtitle=None, notes=None):
    state["n"] += 1
    s = prs.slides.add_slide(BLANK)
    # left accent bar + section label
    bar = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, Inches(0.12), SH)
    bar.fill.solid()
    bar.fill.fore_color.rgb = BLUE
    bar.line.fill.background()
    text(s, MARGIN, Inches(0.38), Inches(9), Inches(0.3), [[(section.upper(), {"bold": True})]], size=11, color=BLUE, space_after=0)
    text(s, MARGIN, Inches(0.66), SW - 2 * MARGIN, Inches(0.7), [[(title, {"bold": True})]], size=28, color=INK, space_after=0)
    if subtitle:
        text(s, MARGIN, Inches(1.32), SW - 2 * MARGIN, Inches(0.5), subtitle, size=15, color=MUTED, space_after=0)
    # footer
    text(s, MARGIN, SH - Inches(0.42), Inches(8), Inches(0.3), [[("FlexPrice ", {"bold": True, "color": NAVY}), ("AI", {"bold": True, "color": BLUE}), ("  ·  Pricing intelligence & adaptive billing on PayPal", {})]], size=10, color=MUTED, space_after=0)
    text(s, SW - MARGIN - Inches(1), SH - Inches(0.42), Inches(1), Inches(0.3), str(state["n"]), size=10, color=MUTED, align=PP_ALIGN.RIGHT, space_after=0)
    if notes:
        s.notes_slide.notes_text_frame.text = notes
    return s


CONTENT_TOP = Inches(1.95)


# =============================================================================================
# 1. Title
# =============================================================================================
state["n"] += 1
s = prs.slides.add_slide(BLANK)
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, SW, SH)
bg.fill.solid()
bg.fill.fore_color.rgb = NAVY
bg.line.fill.background()
glow = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(9.9), Inches(-2.6), Inches(6.6), Inches(6.6))
glow.fill.solid()
glow.fill.fore_color.rgb = RGBColor(0x16, 0x3A, 0x8A)
glow.line.fill.background()
text(s, Inches(0.9), Inches(1.5), Inches(9), Inches(0.5), [[("PAYPAL HACKATHON  ·  2026", {"bold": True})]], size=13, color=SKY)
text(s, Inches(0.9), Inches(2.05), Inches(11), Inches(1.2), [[("FlexPrice ", {"bold": True, "color": WHITE}), ("AI", {"bold": True, "color": SKY})]], size=60, color=WHITE)
text(s, Inches(0.9), Inches(3.3), Inches(10.5), Inches(1.2), "A plug-and-play pricing advisor and adaptive billing framework that lets subscription businesses charge customers the way they actually use the product — on PayPal.", size=22, color=RGBColor(0xC7, 0xD7, 0xFE), spacing=1.2)
for i, (lbl, col) in enumerate([("Plug-and-play adapter framework", SKY), ("Deterministic pricing engine", SKY), ("Claude-powered explanations", RGBColor(0xD6, 0xBB, 0xFB)), ("PayPal Orders · Vault · Webhooks", RGBColor(0xFE, 0xC8, 0x4B))]):
    p = pill(s, Inches(0.9) + Inches(i * 2.95), Inches(5.0), lbl, color=col, fill=NAVY, size=11)
    p.width = Inches(2.8)
s.notes_slide.notes_text_frame.text = "FlexPrice AI: a framework merchants plug into their existing subscription backend to offer flexible, usage-aware pricing, explained by Claude and paid through PayPal."

# =============================================================================================
# 2. Problem
# =============================================================================================
s = new_slide("The problem", "One price for everyone fits almost no one", notes="Fixed subscriptions charge the same regardless of use. Light users feel they overpay and cancel; merchants answer with discounts, which train discount-seeking and create price shock. Merchants rarely have a per-customer view of which plan fits, and adding usage-based plans usually means replacing billing.")
problems = [
    ("Light users overpay, then cancel", "Occasional users pay the same flat price as heavy users. Perceived waste drives cancellations."),
    ("Discounts become a habit", "\"Click cancel, get a discount\" retains briefly, teaches discount-seeking, and ends in a price shock when the promo expires."),
    ("Flexible plans are hard to evaluate", "Customers can't tell whether pay-as-you-go would be cheaper for them; merchants can't show it per customer."),
    ("Billing systems resist change", "Adding usage-based plans usually means replacing the subscription platform — a non-starter for most merchants."),
]
cw = (SW - 2 * MARGIN - Inches(0.6)) / 2
for i, (t, d) in enumerate(problems):
    x = MARGIN + (i % 2) * (cw + Inches(0.6))
    y = CONTENT_TOP + (i // 2) * Inches(1.95)
    box(s, x, y, cw, Inches(1.7), fill=SOFT, line=LINE)
    text(s, x + Inches(0.3), y + Inches(0.25), cw - Inches(0.6), Inches(0.4), [[(t, {"bold": True})]], size=18, color=INK)
    text(s, x + Inches(0.3), y + Inches(0.78), cw - Inches(0.6), Inches(0.9), d, size=14, color=BODY)
box(s, MARGIN, Inches(6.0), SW - 2 * MARGIN, Inches(0.7), fill=BLUE_BG, line=None)
text(s, MARGIN + Inches(0.3), Inches(6.0), SW - 2 * MARGIN - Inches(0.6), Inches(0.7), [[("The gap: ", {"bold": True, "color": NAVY}), ("nobody can see, per customer, which plan actually fits — and merchants can't add flexible plans without rebuilding billing.", {})]], size=15, color=BODY, anchor=MSO_ANCHOR.MIDDLE)

# =============================================================================================
# 3. Core idea
# =============================================================================================
s = new_slide("The core idea", "Decide deterministically, explain with AI, bill on PayPal", "For every customer: forecast usage, compare every eligible plan over the same horizon, recommend the best fit, and collect payment.", notes="Three pillars. The decision layer is deterministic code — every price is computed in integer cents. Claude explains and converses but cannot invent numbers or move money. PayPal handles all payments including saved-account renewals and usage invoices.")
cols = [
    ("1  Decide", "Deterministic decision engine", ["Forecast usage from history (trend + seasonality) with an 80% range", "Price every plan: fixed, annual, usage, hybrid, tiered, caps", "Rank on risk-adjusted cost × customer preference", "Policy engine: eligibility, caps, consent, fair offers"], BLUE_BG, BLUE),
    ("2  Explain", "Claude, grounded in the engine", ["Plain-language \"why this plan\"", "Chat: \"2 movies a week, no commitment\" → engine inputs", "Merchant copilot proposes catalog experiments", "Any $ or % not produced by the engine is rejected"], PURPLE_BG, PURPLE),
    ("3  Bill", "PayPal end to end", ["Orders v2 checkout, verified server-side", "Vault: saved account for renewals & usage invoices", "Proration credits, notices, retries, reconciliation", "Signed webhooks both ways (PayPal → us → merchant)"], AMBER_BG, AMBER),
]
cw = (SW - 2 * MARGIN - Inches(0.5)) / 3
for i, (h, sub, items, bgc, col) in enumerate(cols):
    x = MARGIN + i * (cw + Inches(0.25))
    box(s, x, Inches(2.05), cw, Inches(3.75), fill=bgc, line=None)
    text(s, x + Inches(0.3), Inches(2.25), cw - Inches(0.6), Inches(0.5), [[(h, {"bold": True})]], size=22, color=col)
    text(s, x + Inches(0.3), Inches(2.8), cw - Inches(0.6), Inches(0.4), [[(sub, {"bold": True})]], size=14, color=INK)
    text(s, x + Inches(0.3), Inches(3.3), cw - Inches(0.6), Inches(2.4), items, size=13.5, color=BODY, bullet=True)
box(s, MARGIN, Inches(6.0), SW - 2 * MARGIN, Inches(0.7), fill=NAVY, line=None)
text(s, MARGIN + Inches(0.3), Inches(6.0), SW - 2 * MARGIN - Inches(0.6), Inches(0.7), [[("Design principle:  ", {"bold": True, "color": SKY}), ("deterministic money, AI words.", {"bold": True, "color": WHITE}), ("  The merchant's backend stays the source of truth.", {"color": RGBColor(0xC7, 0xD7, 0xFE)})]], size=16, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)

# =============================================================================================
# 4. Architecture
# =============================================================================================
s = new_slide("Architecture", "Three zones, clean boundaries", notes="Left: the merchant — website with the embedded widget, and the backend which stays the source of truth. Middle: the FlexPrice framework — Widget API, the deterministic decision core, the AI layer, billing, the adapter gateway and the merchant API. Right: Claude and PayPal. In a self-hosted deployment only PayPal and, optionally, Anthropic calls leave the merchant's network.")
pic = image(s, ASSETS / "architecture.png", MARGIN, Inches(1.45), h=Inches(5.45), border=False)
pic.left = int((SW - pic.width) / 2)

# =============================================================================================
# 5. How it works
# =============================================================================================
s = new_slide("How it works", "From \"view plans\" to a renewed subscription", notes="Six steps. The merchant's data never moves: FlexPrice reads it through the adapter. A browser redirect is never treated as proof of payment — the server verifies the PayPal capture, asks the merchant to change the plan and reads it back. The table shows what each customer action costs.")
flow = [
    ("Sign in", "Merchant backend signs a short-lived customer session; page embeds the widget."),
    ("Gather", "Plans + usage history read through the adapter; cached per customer."),
    ("Decide", "Forecast → price every plan over 12 months → recommend; policy applied."),
    ("Explain", "Claude explains with read-only tools; numbers verified against the engine."),
    ("Pay", "Exact terms accepted → PayPal checkout or saved account → server verifies → plan changed → read back."),
    ("Bill", "Usage streamed; month-end invoices and renewals charged to saved PayPal after a notice."),
]
fw = (SW - 2 * MARGIN - Inches(0.25) * 5) / 6
for i, (h, d) in enumerate(flow):
    x = MARGIN + i * (fw + Inches(0.25))
    col = [BLUE, BLUE, NAVY, PURPLE, AMBER, AMBER][i]
    circ = s.shapes.add_shape(MSO_SHAPE.OVAL, x + (fw - Inches(0.7)) / 2, CONTENT_TOP, Inches(0.7), Inches(0.7))
    circ.fill.solid()
    circ.fill.fore_color.rgb = col
    circ.line.fill.background()
    circ.shadow.inherit = False
    tf = circ.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    _runs(p, str(i + 1), 20, WHITE, bold=True)
    if i < 5:
        arrow(s, x + fw - Inches(0.05), CONTENT_TOP + Inches(0.2), w=Inches(0.35), h=Inches(0.3), color=LINE)
    text(s, x, CONTENT_TOP + Inches(0.9), fw, Inches(0.4), [[(h, {"bold": True})]], size=17, color=INK, align=PP_ALIGN.CENTER)
    text(s, x, CONTENT_TOP + Inches(1.4), fw, Inches(1.9), d, size=12.5, color=BODY, align=PP_ALIGN.CENTER)
rows = [
    ["Customer action", "What FlexPrice does", "Merchant calls", "LLM calls"],
    ["Opens plans page", "Serves the precomputed recommendation for this customer", "First view only", "≤ 1 per snapshot"],
    ["Adjusts expected usage", "Recomputes on the fly (~0.05 ms)", "0", "0 (template; AI on request)"],
    ["Uses the product", "Records event; checks break-even thresholds", "0", "0"],
]
table(s, MARGIN, Inches(5.05), SW - 2 * MARGIN, rows, [Inches(2.6), Inches(5.4), Inches(1.9), Inches(2.23)], size=12, row_h=Inches(0.4))

# =============================================================================================
# 6. Plug-and-play
# =============================================================================================
s = new_slide("Plug-and-play framework", "One adapter contract — any merchant backend", "Merchants write a thin translation layer and declare what they support. FlexPrice never assumes an undeclared capability.", notes="The adapter contract is language-agnostic REST, or an in-process JavaScript object. Only 'plans' is required; each declared capability unlocks features and missing ones are hidden automatically — no metering means usage plans are not shown. The gateway validates every response, and a conformance suite checks any adapter before go-live. The merchant keeps customers, plans, entitlements and its existing billing.")
caps = [
    ("plans", "Pricing advice (required)"),
    ("customer_context", "Current plan, tenure, eligibility"),
    ("usage_history", "Personalised forecasts"),
    ("usage_metering", "Usage-based plans"),
    ("change_plan · subscription_status", "Switching, with read-back verification"),
    ("pause · cancel · retention_offers", "Fair retention alternatives"),
    ("cohort_usage", "Anonymised pricing insights"),
]
rows = [["Capability (declared by adapter)", "Unlocks"]] + [[[(c, {"bold": True, "color": INK})], u] for c, u in caps]
table(s, MARGIN, CONTENT_TOP, Inches(6.9), rows, [Inches(3.6), Inches(3.3)], size=12.5, row_h=Inches(0.47))
rx = MARGIN + Inches(7.3)
rw = SW - rx - MARGIN
text(s, rx, CONTENT_TOP - Inches(0.05), rw, Inches(0.4), [[("Three ways to plug in", {"bold": True})]], size=16, color=INK)
styles = [
    ("HTTP adapter", "Expose the REST contract from any backend, in any language.", BLUE),
    ("SDK adapter", "Node merchants implement methods; createAdapterRouter() serves the contract.", PURPLE),
    ("Zero-code catalog", "Just a plan list and checkout URL — advice from customer estimates.", GREEN),
]
for i, (tag, d, col) in enumerate(styles):
    y = CONTENT_TOP + Inches(0.45) + i * Inches(1.0)
    box(s, rx, y, rw, Inches(0.85), fill=SOFT, line=None)
    pill(s, rx + Inches(0.2), y + Inches(0.12), tag, color=col)
    text(s, rx + Inches(0.2), y + Inches(0.45), rw - Inches(0.4), Inches(0.4), d, size=12, color=BODY)
box(s, MARGIN, Inches(5.95), SW - 2 * MARGIN, Inches(0.75), fill=GREEN_BG, line=None)
text(s, MARGIN + Inches(0.3), Inches(5.95), SW - 2 * MARGIN - Inches(0.6), Inches(0.75), [[("The merchant keeps ", {"bold": True, "color": GREEN}), ("customers, login, plans, entitlements, usage data and its existing billing system. ", {}), ("The gateway enforces ", {"bold": True, "color": GREEN}), ("declared capabilities, schema validation, timeouts and health checks.", {})]], size=13.5, color=BODY, anchor=MSO_ANCHOR.MIDDLE)

# =============================================================================================
# 7. Decision engine
# =============================================================================================
s = new_slide("The heart of the system", "A deterministic decision engine — no LLM in the loop", "Pure functions, integer-cent math, ~0.05 ms per customer (~20,000 customers/second on one core). Also shipped as an embeddable library.", notes="Forecaster: Holt damped trend with seasonal indices and a residual-based 80% range; uses history first, then the customer's own estimate, then a merchant default. Pricing engine: integer cents, tiers, included usage, minimums, caps, annual terms, break-even points. Recommender: risk-adjusted cost over a common 12-month horizon, weighted by the customer's preference. Policy engine gates everything.")
stages = [
    ("Forecaster", "Usage history →\ntrend + seasonality\n→ low / expected / high", BLUE_BG, BLUE),
    ("Pricing engine", "Every plan priced over\nthe same 12 months;\ncaps, tiers, break-evens", BLUE_BG, BLUE),
    ("Recommender", "Risk-adjusted cost ×\npreference (balanced,\ncheapest, predictable…)", BLUE_BG, BLUE),
    ("Policy engine", "Eligibility, caps, consent,\nanti-gaming cooldown,\nfair retention offers", GREEN_BG, GREEN),
]
stw = (SW - 2 * MARGIN - Inches(0.5) * 3) / 4
for i, (h, d, bgc, col) in enumerate(stages):
    x = MARGIN + i * (stw + Inches(0.5))
    box(s, x, Inches(2.2), stw, Inches(1.75), fill=bgc, line=None)
    text(s, x + Inches(0.2), Inches(2.35), stw - Inches(0.4), Inches(0.4), [[(h, {"bold": True})]], size=17, color=col)
    text(s, x + Inches(0.2), Inches(2.85), stw - Inches(0.4), Inches(1.1), d.split("\n"), size=12.5, color=BODY, space_after=0)
    if i < 3:
        arrow(s, x + stw + Inches(0.08), Inches(2.9), w=Inches(0.34), h=Inches(0.3), color=MUTED)
hw = (SW - 2 * MARGIN - Inches(0.4)) / 2
card(s, MARGIN, Inches(4.25), hw, Inches(2.45), "Inputs", ["Plan catalog from the adapter (any pricing model)", "Customer's usage history, or their own estimate", "Customer preference: balanced, cheapest, predictable, no commitment", "Merchant policy: eligibility, caps, proration, offers"], fill=SOFT, line=None, size=13)
card(s, MARGIN + hw + Inches(0.4), Inches(4.25), hw, Inches(2.45), "Outputs", ["Expected cost and low–high range for every plan", "Recommended plan, savings and decision factors", "Break-even usage points between plans", "Policy decisions: what may be shown, offered or charged"], fill=SOFT, line=None, size=13)

# =============================================================================================
# 8. AI
# =============================================================================================
s = new_slide("Where AI fits — and where it doesn't", "Claude explains, converses and proposes. It never prices.", "Called through the Anthropic Messages API; every feature has a deterministic fallback.", notes="Claude receives compact facts, never the customer base's raw logs. The grounding guard rejects any dollar amount or percentage not produced by the engine. Customer names, emails and payment data are never sent; chat text is PII-redacted. The AI cannot change plans or charge — the policy engine rejects the AI actor. For forecasting and price sensitivity, the roadmap is trained tabular models once real data exists; the pricing math stays deterministic.")
rows = [
    ["Feature", "Input to Claude", "Claude's tools", "Output"],
    ["Explain recommendation", "~1–2 KB of engine-computed facts; no identity", "—", "3–4 sentence explanation"],
    ["Conversational advisor", "PII-redacted customer message + history", "compare_plans, usage_summary, retention_options (read-only)", "Reply + UI actions (set usage, preference, highlight plan)"],
    ["Merchant pricing copilot", "Catalog + aggregated usage histograms + guardrails", "simulate_catalog, submit_proposals", "≤ 3 catalog experiments, each re-simulated server-side"],
]
table(s, MARGIN, Inches(2.0), SW - 2 * MARGIN, rows, [Inches(2.5), Inches(3.4), Inches(3.4), Inches(2.83)], size=12, row_h=Inches(0.62))
guards = [
    ("Grounding guard", "Every $ and % must come from the engine, or the reply is replaced."),
    ("Read-only tools", "AI cannot change plans, apply discounts or charge."),
    ("Data minimisation", "No names, emails, IDs or payment data; chat PII redacted."),
    ("Cost & latency", "Prices never wait on the LLM; ≤ 1 explanation per customer snapshot."),
]
gw = (SW - 2 * MARGIN - Inches(0.25) * 3) / 4
for i, (h, d) in enumerate(guards):
    x = MARGIN + i * (gw + Inches(0.25))
    box(s, x, Inches(4.75), gw, Inches(1.4), fill=PURPLE_BG, line=None)
    text(s, x + Inches(0.2), Inches(4.88), gw - Inches(0.4), Inches(0.35), [[(h, {"bold": True})]], size=14, color=PURPLE)
    text(s, x + Inches(0.2), Inches(5.28), gw - Inches(0.4), Inches(0.85), d, size=12, color=BODY)
text(s, MARGIN, Inches(6.35), SW - 2 * MARGIN, Inches(0.5), [[("ML roadmap: ", {"bold": True, "color": NAVY}), ("trained tabular models for usage forecasting and churn/price sensitivity once data exists; elasticity measured by experiments. The pricing math stays deterministic.", {})]], size=12.5, color=BODY)

# =============================================================================================
# 9. PayPal & billing
# =============================================================================================
s = new_slide("Billing on PayPal", "Built on PayPal rails, verified on the server", notes="Orders v2 for buyer-present payments, with PayPal-Request-Id idempotency and server-computed amounts; after capture we verify status, amount, currency and custom_id, change the plan at the merchant and read it back. Vault v3 saves the PayPal account so renewals and month-end usage invoices are charged merchant-initiated after a notice, with retries and manual fallback. Switching plans credits unused days. Every billing event is sent to the merchant as a signed webhook.")
rows = [
    ["PayPal product", "How FlexPrice uses it"],
    ["Orders v2", "Buyer-present payments; server-computed amounts; PayPal-Request-Id idempotency"],
    ["Vault v3", "Saved account (with purchase or setup token) for renewals & usage invoices; merchant-initiated charges"],
    ["JS SDK Smart Buttons", "Buyer approval for checkout and for saving PayPal"],
    ["Webhooks", "Signature-verified, deduplicated; recovers approved-but-uncaptured orders"],
    ["Refunds · Subscriptions catalog", "Idempotent refunds; fixed plans mirrored into PayPal Products & Plans"],
]
table(s, MARGIN, CONTENT_TOP - Inches(0.35), Inches(7.4), rows, [Inches(2.4), Inches(5.0)], size=12, row_h=Inches(0.62))
rx = MARGIN + Inches(7.8)
rw = SW - rx - MARGIN
box(s, rx, CONTENT_TOP - Inches(0.35), rw, Inches(4.75), fill=AMBER_BG, line=None)
text(s, rx + Inches(0.3), CONTENT_TOP - Inches(0.2), rw - Inches(0.6), Inches(0.4), [[("Billing lifecycle", {"bold": True})]], size=16, color=AMBER)
text(s, rx + Inches(0.3), CONTENT_TOP + Inches(0.3), rw - Inches(0.6), Inches(4.1), [
    [("Consent ", {"bold": True, "color": INK}), ("bound to a hash of the exact terms", {})],
    [("Capture verified ", {"bold": True, "color": INK}), ("on the server, then plan read back", {})],
    [("Renewals ", {"bold": True, "color": INK}), ("charged to saved PayPal after a reminder", {})],
    [("Usage invoices ", {"bold": True, "color": INK}), ("monthly, never above the spending cap", {})],
    [("Proration ", {"bold": True, "color": INK}), ("credits unused days when switching", {})],
    [("Retries ", {"bold": True, "color": INK}), ("then past-due + manual payment fallback", {})],
    [("Signed webhooks ", {"bold": True, "color": INK}), ("tell the merchant about every event", {})],
], size=13, color=BODY, bullet=True, space_after=4)
text(s, MARGIN, Inches(6.35), SW - 2 * MARGIN, Inches(0.5), "A browser redirect is never proof of payment. Paid-but-unfulfilled changes are reconciled without charging twice.", size=12, color=MUTED)

# =============================================================================================
# 10. Advantages
# =============================================================================================
s = new_slide("Advantages", "Value for customers, merchants and PayPal", notes="Customers get transparency and fair prices. Merchants get flexible pricing without replacing billing, retention without discount habits, and honest revenue analytics. For PayPal: usage-based and recurring charges run as merchant-initiated transactions on Vault; billing reliability features reduce involuntary churn; the framework gives subscription merchants a reason to choose and stay on PayPal; it is distributable through PayPal Commerce Platform; and PayPal stays the payments layer without holding merchant usage data.")
cols = [
    ("Customers", GREEN, GREEN_BG, ["See what each plan would cost them — with a range — before paying", "Pay for what they use, never above a spending cap", "Credit for unused time when switching", "Reminder before every renewal and usage charge", "No pressure tactics; cancellation always available"]),
    ("Merchants", BLUE, BLUE_BG, ["Usage, hybrid, tiered and annual plans without replacing billing", "Thin adapter; their backend stays the source of truth", "Fewer cancellations: fitting plans offered before \"cancel\"", "Revenue impact shown + revenue-neutral pricing solver", "Signed events to email customers and manage access"]),
    ("PayPal", PP_BLUE, AMBER_BG, ["More transactions: monthly usage and renewal charges on PayPal", "Vault adoption: saved accounts with explicit consent", "Lower involuntary churn: notices, retries, fallback", "Merchant stickiness: a billing-intelligence layer on PayPal rails", "Distribution via PayPal Commerce Platform; no usage-data custody"]),
]
for i, (h, col, bgc, items) in enumerate(cols):
    x = MARGIN + i * (cw + Inches(0.25))
    box(s, x, CONTENT_TOP - Inches(0.25), cw, Inches(5.0), fill=bgc, line=None)
    text(s, x + Inches(0.3), CONTENT_TOP, cw - Inches(0.6), Inches(0.5), [[(h, {"bold": True})]], size=22, color=col)
    text(s, x + Inches(0.3), CONTENT_TOP + Inches(0.65), cw - Inches(0.6), Inches(4.0), items, size=14, color=BODY, bullet=True, space_after=10)

# =============================================================================================
# 11. Scalability
# =============================================================================================
s = new_slide("Scalability", "Cheap on read, recompute only on change", notes="The engine costs ~0.05 ms per customer — not the bottleneck. The real costs are network calls to the merchant and LLM calls. So the default view is a precomputed per-customer snapshot; what-ifs reuse cached data; LLM explanations are generated at most once per snapshot. Usage events don't trigger recomputation: the recommendation can only change when monthly usage crosses a break-even point, so each event is a handful of comparisons.")
rows = [
    ["What costs time on \"view plans\"", "Cost"],
    ["Deterministic engine (forecast + price + recommend)", "~0.05 ms per customer"],
    ["Fetching customer + 24-month usage from the merchant", "2 network calls (20–200 ms typical)"],
    ["Claude explanation (optional)", "~1–3 s and per-token cost"],
]
table(s, MARGIN, CONTENT_TOP - Inches(0.25), Inches(6.6), rows, [Inches(4.3), Inches(2.3)], size=12, row_h=Inches(0.48))
text(s, MARGIN, Inches(3.95), Inches(6.6), Inches(0.4), [[("1 view + 20 usage adjustments: before → after", {"bold": True})]], size=15, color=INK)
for i, (v, l) in enumerate([("42 → 2", "merchant calls"), ("21 → 1", "analytics rows"), ("≤ 1", "LLM call per snapshot")]):
    stat(s, MARGIN + i * Inches(2.2), Inches(4.4), Inches(2.1), v, l, color=BLUE, value_size=28)
rx = MARGIN + Inches(7.0)
rw = SW - rx - MARGIN
box(s, rx, CONTENT_TOP - Inches(0.25), rw, Inches(4.3), fill=BLUE_BG, line=None)
text(s, rx + Inches(0.3), CONTENT_TOP - Inches(0.1), rw - Inches(0.6), Inches(0.4), [[("What triggers a recomputation", {"bold": True})]], size=15, color=NAVY)
text(s, rx + Inches(0.3), CONTENT_TOP + Inches(0.4), rw - Inches(0.6), Inches(3.6), [
    "Plan change, pause or cancel",
    "Billing month closes (new history)",
    "Plan catalog changes (version hash)",
    "Merchant signals a change (invalidate API)",
    [("Live usage crosses a break-even point", {"bold": True, "color": INK}), (" — each usage event is a few comparisons, not a recomputation", {})],
    "Bulk precompute after month close",
], size=13, color=BODY, bullet=True, space_after=8)
text(s, MARGIN, Inches(6.2), SW - 2 * MARGIN, Inches(0.6), [[("At large scale: ", {"bold": True, "color": NAVY}), ("same interfaces backed by Redis (snapshots), Postgres (state), Kafka (usage events), a batch job writing precomputed recommendations, CDN for the widget.", {})]], size=12.5, color=BODY)

# =============================================================================================
# 12. Deployment
# =============================================================================================
s = new_slide("Deployment", "Run it where the data lives", notes="For large merchants we recommend self-hosting: a stateless service in their own network, with the widget served from their domain. Teams that only want the decision engine can embed the library in-process. Smaller merchants can use a hosted multi-tenant service, onboarded through PayPal Commerce Platform so funds go directly to them. PayPal's role is payments in every model.")
models = [
    ("Recommended", "Self-hosted service", ["Runs inside the merchant's own network", "Adapter calls stay internal; widget served from the merchant's domain", "Only PayPal (and optional Anthropic) calls leave the network", "Stateless; scales horizontally"], GREEN),
    ("Zero hops", "Embedded library", ["Decision engine imported as a library", "Pure functions — no network, storage or LLM", "Runs inside the plans-page backend or a batch job"], BLUE),
    ("Small merchants", "Hosted multi-tenant", ["Adapter exposed over HTTPS (key + mTLS / allow-list)", "Tenant isolation by merchant API key", "PayPal Commerce Platform onboarding so each merchant is paid directly"], PURPLE),
]
for i, (tag, h, items, col) in enumerate(models):
    x = MARGIN + i * (cw + Inches(0.25))
    card(s, x, CONTENT_TOP - Inches(0.15), cw, Inches(3.6), h, items, tag=tag, tag_color=col, size=13)
box(s, MARGIN, Inches(5.65), SW - 2 * MARGIN, Inches(1.0), fill=AMBER_BG, line=None)
text(s, MARGIN + Inches(0.3), Inches(5.65), SW - 2 * MARGIN - Inches(0.6), Inches(1.0), [[("Who maintains it? ", {"bold": True, "color": AMBER}), ("The merchant (self-hosted or library) — or a hosted provider. PayPal's role is payments: Orders, Vault, webhooks. Merchant usage data never has to leave the merchant.", {})]], size=14, color=BODY, anchor=MSO_ANCHOR.MIDDLE)

# =============================================================================================
# 13. Close
# =============================================================================================
state["n"] += 1
s = prs.slides.add_slide(BLANK)
bg = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, SW, SH)
bg.fill.solid()
bg.fill.fore_color.rgb = NAVY
bg.line.fill.background()
text(s, Inches(0.9), Inches(1.4), Inches(11), Inches(1), [[("FlexPrice ", {"bold": True, "color": WHITE}), ("AI", {"bold": True, "color": SKY})]], size=48, color=WHITE)
text(s, Inches(0.9), Inches(2.5), Inches(11.5), Inches(2.6), [
    [("Plug-and-play: ", {"bold": True, "color": SKY}), ("one adapter contract, any merchant backend, data stays with the merchant", {})],
    [("Deterministic core: ", {"bold": True, "color": SKY}), ("every price computed in cents — AI explains, never prices", {})],
    [("PayPal-native billing: ", {"bold": True, "color": RGBColor(0xFE, 0xC8, 0x4B)}), ("Orders, Vault renewals & usage charges, verified webhooks", {})],
    [("Fair for everyone: ", {"bold": True, "color": RGBColor(0xD6, 0xBB, 0xFB)}), ("transparent prices for customers, honest revenue analytics for merchants", {})],
    [("Built to scale: ", {"bold": True, "color": SKY}), ("precomputed snapshots, event-driven recomputation, self-hostable", {})],
], size=19, color=RGBColor(0xC7, 0xD7, 0xFE), space_after=12)
text(s, Inches(0.9), Inches(5.9), Inches(11), Inches(0.6), [[("Thank you", {"bold": True})]], size=26, color=WHITE)

prs.save(OUT)
print(f"wrote {OUT} ({state['n']} slides)")
