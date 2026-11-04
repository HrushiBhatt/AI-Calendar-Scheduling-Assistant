"""Draws the README's animated diagrams and charts. Run: python3 docs/assets/generate.py

The charts only use real numbers: score.go's weights, measured coverage (data/coverage.json)
and actual planner output for a sample day (data/sample-day.json). Update those inputs from
a real run, never by hand. Chart colors pass the dataviz palette check on the dark surface.
"""
import json, pathlib
OUT = pathlib.Path(__file__).parent; DATA = OUT / 'data'

BG0, BG1 = '#14100d', '#231913'
PANEL, LINE = '#1c1714', '#332a24'
TEXT, TEXT2, MUTED = '#efebe9', '#c4b8ae', '#8d8077'
ACCENT, BRIGHT, COFFEE, CREMA = '#d4a574', '#e8c49a', '#6f4e37', '#a67c52'
MEET, GOOD, BAD = '#57504a', '#8fd19e', '#ef5350'
SANS = 'ui-sans-serif,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif'
MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,&quot;Liberation Mono&quot;,monospace'

def esc(s): return s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def frame(w, h, label, css, body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="{esc(label)}">
<title>{esc(label)}</title>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="0.3"><stop offset="0" stop-color="{BG0}"/><stop offset="1" stop-color="{BG1}"/></linearGradient>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#ffffff" fill-opacity=".05"/></pattern>
<clipPath id="panel"><rect width="{w}" height="{h}" rx="14"/></clipPath>
</defs>
<style>
text{{font-family:{SANS};fill:{TEXT2};font-size:13px}}
.m{{font-family:{MONO}}}
.h{{fill:{TEXT};font-weight:600}}
.mu{{fill:{MUTED}}}
.k{{font-family:{MONO};letter-spacing:.12em;font-size:11px;fill:{ACCENT}}}
{css}
@media (prefers-reduced-motion:reduce){{*{{animation:none!important}}}}
</style>
<g clip-path="url(#panel)">
<rect width="{w}" height="{h}" fill="url(#bg)"/><rect width="{w}" height="{h}" fill="url(#dots)"/>
{body}
</g>
</svg>
'''

def text(x, y, s, cls='', size=None, anchor=None, extra=''):
    a = f' class="{cls}"' if cls else ''
    if size and 'style=' not in extra: a += f' style="font-size:{size}px"'
    if anchor: a += f' text-anchor="{anchor}"'
    return f'<text x="{x}" y="{y}"{a} {extra}>{esc(s)}</text>'

# ---- pixel lettering, drawn from rectangles so it needs no font ------------------------
GLYPHS = {
 'B':'11110 10001 10001 11110 10001 10001 11110','R':'11110 10001 10001 11110 10100 10010 10001',
 'E':'11111 10000 10000 11110 10000 10000 11111','W':'10001 10001 10001 10101 10101 11011 10001',
 'F':'11111 10000 10000 11110 10000 10000 10000','O':'01110 10001 10001 10001 10001 10001 01110',
 'C':'01111 10000 10000 10000 10000 10000 01111','U':'10001 10001 10001 10001 10001 10001 01110',
 'S':'01111 10000 10000 01110 00001 00001 11110',' ':'00000 00000 00000 00000 00000 00000 00000'}
def pixel_title(x, y, s, cell, fill):
    out = []
    for i, ch in enumerate(s):
        for r, row in enumerate(GLYPHS[ch].split()):
            for c, bit in enumerate(row):
                if bit == '1':
                    out.append(f'<rect x="{x + (i*6 + c)*cell}" y="{y + r*cell}" width="{cell}" height="{cell}" fill="{fill}"/>')
    return ''.join(out)

# ---- the app's own mug ----------------------------------------------------------------
INK='#2A2A2A'
BODY=[(32,40,120,8,'#E8E8E8')]+[(24,48+i*8,136,8,'#F5F5F5' if i%3==2 else '#FFFFFF') for i in range(13)]+[(24,152,136,8,'#F0F0F0'),(24,160,136,8,'#E8E8E8'),(32,168,120,8,'#E0E0E0'),(40,176,104,8,'#D8D8D8')]
OUTLINE=[(32,32,120,8),(24,40,8,8),(152,40,8,8),(16,48,8,136),(160,48,8,120),(16,176,8,8),(24,184,8,8),(32,184,120,8),(152,184,8,8),(160,168,8,16),(160,56,8,8),(168,48,16,8),(184,56,8,16),(192,72,8,56),(184,128,8,16),(168,144,16,8),(160,136,8,8)]
HANDLE=[(168,56,16,8,'#FFFFFF'),(176,64,8,8,'#FFFFFF'),(184,72,8,56,'#F5F5F5'),(176,72,8,56,'#E8E8E8'),(176,128,8,8,'#FFFFFF'),(168,136,8,8,'#F0F0F0')]
STEAM=[[(10,30),(10,24),(14,18),(10,12),(6,6)],[(28,32),(28,26),(24,20),(28,14),(32,8)],[(46,30),(46,24),(42,18),(46,12),(50,6)]]
def rects(rs, fill=None):
    return ''.join(f'<rect x="{r[0]}" y="{r[1]}" width="{r[2]}" height="{r[3]}" fill="{r[4] if len(r)>4 else fill}"/>' for r in rs)

def mins(hhmm):
    h,m = hhmm.split(':'); return int(h)*60+int(m)

SAMPLE_BUSY=[('09:30','10:15','Standup'),('13:30','14:15','Design review'),('16:00','16:30','1:1')]
SAMPLE=json.loads((DATA/'sample-day.json').read_text())['blocks']

# ---- hero ------------------------------------------------------------------------------
def hero():
    X0, X1 = 340, 960
    px = lambda t: X0 + (mins(t)-540)/480*(X1-X0)
    css = f'''
.coffee{{transform-box:fill-box;transform-origin:50% 100%;animation:drain 14s steps(30) infinite}}
.crema{{animation:crema 14s steps(30) infinite}}
@keyframes drain{{0%,4%{{transform:scaleY(1)}}86%{{transform:scaleY(.08)}}94%,100%{{transform:scaleY(1)}}}}
@keyframes crema{{0%,4%{{transform:translateY(0)}}86%{{transform:translateY(110.4px)}}94%,100%{{transform:translateY(0)}}}}
.puff{{animation:puff 3.2s ease-out infinite}}
.puff.b{{animation-delay:.9s}}.puff.c{{animation-delay:1.8s}}
@keyframes puff{{0%{{opacity:0;transform:translateY(10px)}}30%{{opacity:1}}100%{{opacity:0;transform:translateY(-14px)}}}}
.drop{{animation:drop 14s cubic-bezier(.34,1.56,.64,1) infinite both}}
.d1{{animation-name:d1}}.d2{{animation-name:d2}}.d3{{animation-name:d3}}
@keyframes d1{{0%,10%{{opacity:0;transform:translateY(-26px)}}15%,94%{{opacity:1;transform:none}}100%{{opacity:0}}}}
@keyframes d2{{0%,18%{{opacity:0;transform:translateY(-26px)}}23%,94%{{opacity:1;transform:none}}100%{{opacity:0}}}}
@keyframes d3{{0%,26%{{opacity:0;transform:translateY(-26px)}}31%,94%{{opacity:1;transform:none}}100%{{opacity:0}}}}
.head{{animation:head 14s linear infinite}}
@keyframes head{{0%{{transform:translateX(0)}}100%{{transform:translateX({X1-X0}px)}}}}
'''
    b = [f'<radialGradient id="g" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="{ACCENT}" stop-opacity=".28"/><stop offset="1" stop-color="{ACCENT}" stop-opacity="0"/></radialGradient>',
         '<circle cx="150" cy="170" r="170" fill="url(#g)"/>']
    b.append('<g transform="translate(50,62) scale(1)" shape-rendering="crispEdges">')
    for i,p in enumerate(STEAM):
        cl = 'puff ' + 'abc'[i]
        b.append(f'<g class="{cl}" transform-origin="0 0"><g transform="translate(70,-26) scale(1.25)">' + ''.join(f'<rect x="{x}" y="{y}" width="4" height="4" fill="#fff" fill-opacity="{.6-j*.1:.1f}"/>' for j,(x,y) in enumerate(p)) + '</g></g>')
    b.append(rects(BODY))
    b.append(f'<rect class="coffee" x="24" y="56" width="136" height="120" fill="{COFFEE}"/>')
    b.append(f'<rect class="crema" x="24" y="48" width="136" height="9" fill="{CREMA}"/>')
    b.append(rects(OUTLINE, INK)+rects(HANDLE)+'</g>')
    b.append(pixel_title(X0+3, 49, 'BREW FOCUS', 7, COFFEE))
    b.append(pixel_title(X0, 46, 'BREW FOCUS', 7, BRIGHT))
    b.append(text(X0, 126, 'Plans your deep work around your real calendar, then runs it on the server.', size=18, extra=f'fill="{TEXT}"'))
    b.append(text(X0, 150, 'The language model reads your request. A deterministic scheduler picks every time.', size=14))
    # a day
    y = 200
    for h in range(9,18):
        x = X0 + (h-9)*60/480*(X1-X0)
        lab = f'{h if h<=12 else h-12}{"am" if h<12 else "pm"}'
        b.append(f'<rect x="{x:.1f}" y="{y-4}" width="1" height="54" fill="{LINE}"/>')
        b.append(text(round(x), y-10, lab, 'm mu', 11, 'middle'))
    b.append(f'<rect x="{X0}" y="{y}" width="{X1-X0}" height="46" rx="4" fill="{PANEL}" stroke="{LINE}"/>')
    for s,e,n in SAMPLE_BUSY:
        b.append(f'<rect x="{px(s):.1f}" y="{y+6}" width="{px(e)-px(s):.1f}" height="34" rx="3" fill="{MEET}"/>')
    for i,bk in enumerate(SAMPLE):
        s = bk['starts_at'][11:16]; x = px(s); w = bk['focus_min']/480*(X1-X0)
        b.append(f'<rect class="drop d{i+1}" x="{x:.1f}" y="{y+6}" width="{w:.1f}" height="34" rx="3" fill="{ACCENT}"/>')
    b.append(f'<g class="head"><rect x="{X0-1}" y="{y-4}" width="2" height="54" fill="{TEXT}" fill-opacity=".8"/></g>')
    ly = y+72
    b.append(f'<rect x="{X0}" y="{ly-10}" width="12" height="12" rx="2" fill="{MEET}"/>'+text(X0+18, ly, 'your meetings', size=12))
    b.append(f'<rect x="{X0+128}" y="{ly-10}" width="12" height="12" rx="2" fill="{ACCENT}"/>'+text(X0+146, ly, 'focus blocks the scheduler placed in the real gaps', size=12))
    return frame(1000, 300, 'Brew Focus: a pixel-art mug drains as a timer runs, while focus blocks drop into the gaps between meetings on a day timeline', css, ''.join(b))

# ---- from a sentence to a running timer -----------------------------------------------
def flow():
    nodes=[(24,'YOU',['“Three blocks on','the compiler project','tomorrow”']),
           (214,'ASSISTANT',['Turns words into one','validated tool call.','Optional.']),
           (404,'PLANNER',['Pure function. Picks','every time. No network,','clock or model.']),
           (594,'YOUR REVIEW',['Every block has its','reason. Accept all,','some, or none.']),
           (784,'DISPATCHER',['60-second warning,','then the block','starts itself.'])]
    W=172; Y=74; H=112; loop=11
    css=f'''
.p1{{animation:p1 {loop}s linear infinite}}
@keyframes p1{{0%{{transform:translateX(0);opacity:0}}3%{{opacity:1}}18%{{transform:translateX(190px)}}26%{{transform:translateX(190px)}}42%{{transform:translateX(380px)}}52%{{transform:translateX(380px)}}66%{{transform:translateX(570px)}}76%{{transform:translateX(570px)}}90%{{transform:translateX(760px);opacity:1}}94%,100%{{transform:translateX(760px);opacity:0}}}}
.lit{{opacity:0;animation-duration:{loop}s;animation-iteration-count:infinite}}
.l0{{animation-name:l0}}.l1{{animation-name:l1}}.l2{{animation-name:l2}}.l3{{animation-name:l3}}.l4{{animation-name:l4}}
@keyframes l0{{0%,6%{{opacity:1}}14%,100%{{opacity:0}}}}
@keyframes l1{{0%,15%{{opacity:0}}19%,27%{{opacity:1}}32%,100%{{opacity:0}}}}
@keyframes l2{{0%,38%{{opacity:0}}43%,53%{{opacity:1}}58%,100%{{opacity:0}}}}
@keyframes l3{{0%,62%{{opacity:0}}67%,77%{{opacity:1}}82%,100%{{opacity:0}}}}
@keyframes l4{{0%,86%{{opacity:0}}91%,99%{{opacity:1}}100%{{opacity:0}}}}
.p2{{animation:p2 {loop}s linear infinite}}
@keyframes p2{{0%,8%{{opacity:0;transform:none}}12%{{opacity:1;transform:none}}30%{{transform:translateX(170px)}}42%{{opacity:1;transform:translate(170px,-52px)}}46%,100%{{opacity:0;transform:translate(170px,-52px)}}}}
'''
    b=[text(24,38,'FROM A SENTENCE TO A RUNNING TIMER','k',12)]
    b.append(f'<rect x="388" y="46" width="204" height="20" rx="3" fill="{ACCENT}" fill-opacity=".14"/>'+text(490,60,'the model never picks a time','m',11,'middle',f'fill="{BRIGHT}" style="fill:{BRIGHT};font-size:11px"'))
    for i,(x,t,ls) in enumerate(nodes):
        hi = t=='PLANNER'
        b.append(f'<rect x="{x}" y="{Y}" width="{W}" height="{H}" rx="6" fill="{PANEL}" stroke="{ACCENT if hi else LINE}" stroke-width="{2 if hi else 1}"/>')
        b.append(f'<rect class="lit l{i}" x="{x}" y="{Y}" width="{W}" height="{H}" rx="6" fill="{ACCENT}" fill-opacity=".14" stroke="{BRIGHT}" stroke-width="2"/>')
        b.append(text(x+14,Y+26,t,'k'))
        for j,l in enumerate(ls):
            b.append(text(x+14,Y+50+j*18,l,size=12.5))
        if i<4:
            b.append(f'<path d="M{x+W+2} {Y+H/2}h13" stroke="{MUTED}" stroke-width="2"/><path d="M{x+W+15} {Y+H/2-5}l6 5-6 5z" fill="{MUTED}"/>')
    b.append(f'<circle class="p1" cx="110" cy="{Y+H-12}" r="6" fill="{BRIGHT}"/>')
    # the path with no model in it
    fy=Y+H+40
    b.append(f'<rect x="214" y="{fy-22}" width="172" height="44" rx="6" fill="{PANEL}" stroke="{LINE}" stroke-dasharray="4 4"/>'+text(300,fy-3,'Planning form','h',12.5,'middle')+text(300,fy+13,'or “fill my free time”','mu',11.5,'middle'))
    b.append(f'<path d="M386 {fy}h104v-{fy-Y-H-3}" fill="none" stroke="{MUTED}" stroke-width="2"/><path d="M485 {Y+H+6}l5-6 5 6z" fill="{MUTED}"/>')
    b.append(f'<circle class="p2" cx="310" cy="{fy}" r="6" fill="{GOOD}"/>')
    b.append(text(510,fy-3,'No API key, or the model provider is down? Same planner, same rules.',size=13))
    b.append(text(510,fy+15,'The feature works without any AI at all.','mu',12.5))
    return frame(1000,270,'Animated flow: a request passes through the optional assistant to the deterministic planner, then your review, then the dispatcher starts the block. A planning form reaches the same planner with no model involved.',css,''.join(b))

# ---- the scheduler, on a real sample day ----------------------------------------------
def planner():
    X0,X1=150,975; px=lambda m:X0+(m-540)/480*(X1-X0)
    busy=[(mins(s),mins(e)) for s,e,_ in SAMPLE_BUSY]
    # free time: the workday, less meetings widened by the 10-minute buffer, and less lunch
    blocked=sorted([(s-10,e+10) for s,e in busy]+[(720,780)])
    free=[];cur=540
    for s,e in blocked:
        if s>cur: free.append((cur,s))
        cur=max(cur,e)
    if cur<1020: free.append((cur,1020))
    loop=15
    rows=[('1','Calendar',64),('2','Free time',116),('3','Candidates',168),('4','Plan',220)]
    def win(a,b):  # appear at a%, hold to b%
        return f'0%,{a}%{{opacity:0}}{a+4}%,{b}%{{opacity:1}}{b+3}%,100%{{opacity:0}}'
    css=f'''
.r1,.r2,.r3,.r4,.why{{animation-duration:{loop}s;animation-iteration-count:infinite;animation-fill-mode:both}}
.r1{{animation-name:r1}}.r2{{animation-name:r2}}.r3{{animation-name:r3}}
@keyframes r1{{{win(2,94)}}}
@keyframes r2{{{win(18,94)}}}
@keyframes r3{{{win(34,94)}}}
.tick{{animation:tick 1.2s ease-in-out infinite}}
@keyframes tick{{0%,100%{{fill-opacity:.25}}50%{{fill-opacity:.95}}}}
.b1{{animation-name:b1}}.b2{{animation-name:b2}}.b3{{animation-name:b3}}
@keyframes b1{{{win(50,94)}}}
@keyframes b2{{{win(60,94)}}}
@keyframes b3{{{win(70,94)}}}
'''
    b=[text(24,30,'THE SCHEDULER, STEP BY STEP','k',12),text(975,30,'actual planner output for this sample day','mu',12,'end')]
    for h in range(9,18):
        x=px(h*60); lab=f'{h if h<=12 else h-12}{"am" if h<12 else "pm"}'
        b.append(f'<rect x="{x:.1f}" y="52" width="1" height="204" fill="{LINE}"/>'+text(round(x),47,lab,'m mu',11,'middle'))
    for n,l,y in rows:
        b.append(text(24,y+21,n,'k')+text(44,y+21,l,'h',13.5))
        b.append(f'<rect x="{X0}" y="{y}" width="{X1-X0}" height="34" rx="3" fill="{PANEL}"/>')
    y=rows[0][2]
    b.append('<g class="r1">')
    for (s,e),(_,_,n) in zip(busy,SAMPLE_BUSY):
        b.append(f'<rect x="{px(s):.1f}" y="{y+4}" width="{px(e)-px(s):.1f}" height="26" rx="2" fill="{MEET}"/>')
        tw=px(e)-px(s)
        if tw>=70: b.append(text(round(px(s)+tw/2),y+21,n,'',11,'middle',f'style="fill:{TEXT};font-size:11px"'))
        else: b.append(text(round(px(e)+6),y+21,n,'',11,None,f'style="fill:{TEXT2};font-size:11px"'))
    b.append('</g>')
    y=rows[1][2]
    b.append('<g class="r2">')
    for s,e in free:
        b.append(f'<rect x="{px(s):.1f}" y="{y+4}" width="{px(e)-px(s):.1f}" height="26" rx="2" fill="{GOOD}" fill-opacity=".22" stroke="{GOOD}" stroke-opacity=".6"/>')
    b.append(text(round(px(750)),y+21,'lunch','mu',11,'middle'))
    b.append('</g>')
    y=rows[2][2]
    b.append('<g class="r3">')
    k=0
    for s,e in free:
        t=s if s%15==0 else s+(15-s%15)
        while t+30<=e:
            b.append(f'<rect class="tick" style="animation-delay:{(k%16)*.075:.2f}s" x="{px(t)+1:.1f}" y="{y+6}" width="4" height="22" fill="{ACCENT}"/>')
            t+=15;k+=1
    b.append('</g>')
    y=rows[3][2]
    for i,bk in enumerate(SAMPLE):
        s=mins(bk['starts_at'][11:16]);w=bk['focus_min']/480*(X1-X0);r=bk['rest_min']/480*(X1-X0)
        b.append(f'<g class="why b{i+1}"><rect x="{px(s):.1f}" y="{y+4}" width="{w:.1f}" height="26" rx="2" fill="{ACCENT}"/><rect x="{px(s)+w:.1f}" y="{y+4}" width="{r:.1f}" height="26" rx="2" fill="{GOOD}" fill-opacity=".35"/></g>')
    b.append(text(round(px(mins('12:08'))),y+21,'each block keeps its 5-minute rest (green)','mu',11.5))
    ty=282
    for i,bk in enumerate(SAMPLE):
        hhmm=bk['starts_at'][11:16]; h=int(hhmm[:2]); disp=f'{h if h<=12 else h-12}:{hhmm[3:]}'
        b.append(f'<g class="why b{i+1}"><rect x="24" y="{ty+i*24-11}" width="12" height="12" rx="2" fill="{ACCENT}"/>'+text(44,ty+i*24,disp,'m',12.5,None,f'style="fill:{TEXT};font-size:12.5px"')+text(92,ty+i*24,bk['task'],'h',13)+text(232,ty+i*24,bk['explain'],'',13)+'</g>')
    return frame(1000,356,'Animated scheduler steps on a sample day: meetings, then free time after buffers and lunch, then candidate start times on a 15-minute grid, then three chosen blocks, each with the scheduler\'s own written reason',css,''.join(b))

# ---- the server owns the timer ---------------------------------------------------------
def timer():
    loop=16
    digits=[f'24:{59-i:02d}' for i in range(16)]
    css=f'''
.dg{{opacity:0;animation:dg {loop}s steps(1) infinite}}
@keyframes dg{{0%{{opacity:1}}6.25%,100%{{opacity:0}}}}
.bar{{transform-box:fill-box;transform-origin:0 50%;animation:bar {loop}s linear infinite}}
@keyframes bar{{0%{{transform:scaleX(1)}}100%{{transform:scaleX(.82)}}}}
.pulse{{animation-duration:2s;animation-iteration-count:infinite;animation-timing-function:linear}}
@keyframes pa{{0%{{transform:translate(0,0);opacity:1}}85%{{opacity:1}}100%{{transform:translate(236px,-82px);opacity:0}}}}
@keyframes pb{{0%{{transform:translate(0,0);opacity:1}}85%{{opacity:1}}100%{{transform:translate(236px,0);opacity:0}}}}
@keyframes pc{{0%{{transform:translate(0,0);opacity:1}}85%{{opacity:1}}100%{{transform:translate(236px,82px);opacity:0}}}}
.gone{{animation:gone {loop}s steps(1) infinite}}
@keyframes gone{{0%,30%{{opacity:1}}30.01%,68%{{opacity:.28}}68.01%,100%{{opacity:1}}}}
.cut{{animation:cut {loop}s steps(1) infinite}}
@keyframes cut{{0%,30%{{visibility:visible}}30.01%,68%{{visibility:hidden}}68.01%,100%{{visibility:visible}}}}
.n1{{animation:n1 {loop}s steps(1) infinite;opacity:0}}
@keyframes n1{{0%,30%{{opacity:0}}30.01%,68%{{opacity:1}}68.01%,100%{{opacity:0}}}}
.n2{{animation:n2 {loop}s steps(1) infinite;opacity:0}}
@keyframes n2{{0%,68%{{opacity:0}}68.01%,86%{{opacity:1}}86.01%,100%{{opacity:0}}}}
.disk{{animation:disk 4s ease-in-out infinite}}
@keyframes disk{{0%,70%,100%{{fill-opacity:.15}}80%{{fill-opacity:.8}}}}
'''
    b=[text(24,32,'THE SERVER OWNS THE TIMER','k',12)]
    # server
    b.append(f'<rect x="24" y="50" width="396" height="240" rx="8" fill="{PANEL}" stroke="{ACCENT}" stroke-width="2"/>')
    b.append(text(44,78,'Go server','h',15)+text(404,78,'one goroutine per running timer','mu',12,'end'))
    b.append(f'<rect x="44" y="94" width="356" height="92" rx="6" fill="#120e0b" stroke="{LINE}"/>')
    b.append(text(60,116,'TIMER ACTOR','k'))
    for i,d in enumerate(digits):
        b.append(f'<text class="dg m{" first" if i==0 else ""}" style="animation-delay:{-(loop-i) if i else 0}s;font-size:34px;fill:{TEXT};font-weight:700" x="60" y="164">{d}</text>')
    b.append(f'<rect x="200" y="146" width="184" height="12" rx="2" fill="{LINE}"/><rect class="bar" x="200" y="146" width="184" height="12" rx="2" fill="{ACCENT}"/>')
    b.append(text(44,212,'Commands arrive over a channel. Nothing else touches its',size=12.5)+text(44,230,'state, so it needs no locks and can\'t race.',size=12.5))
    b.append(f'<rect class="disk" x="44" y="248" width="16" height="24" rx="3" fill="{GOOD}" stroke="{GOOD}"/>')
    b.append(text(70,258,'SQLite: saved at the start and on every change',size=12.5)+text(70,275,'A restart restores every running and paused timer.','mu',12))
    # devices
    devs=[('Laptop','laptop',102),('Phone','phone',184),('Second tab','tab',266)]
    for n,(name,_,y) in enumerate(devs):
        cl=' class="gone"' if n==0 else ''
        b.append(f'<g{cl}><rect x="668" y="{y-30}" width="308" height="62" rx="6" fill="{PANEL}" stroke="{LINE}"/>')
        b.append(text(684,y-6,name,'h',13))
        for i,d in enumerate(digits):
            b.append(f'<text class="dg m{" first" if i==0 else ""}" style="animation-delay:{-(loop-i) if i else 0}s;font-size:13px;fill:{TEXT2}" x="684" y="{y+15}">{d}</text>')
        b.append(f'<rect x="740" y="{y+6}" width="220" height="8" rx="2" fill="{LINE}"/><rect class="bar" x="740" y="{y+6}" width="220" height="8" rx="2" fill="{ACCENT}"/></g>')
    b.append(text(960,102-6,'closed: timer keeps running','n1',12,'end',f'style="fill:{BRIGHT};font-size:12px"'))
    b.append(text(960,102-6,'reopened: instantly in sync','n2',12,'end',f'style="fill:{GOOD};font-size:12px"'))
    # streams
    for k,(name,y,kf,dly) in enumerate([('a',102,'pa',0),('b',184,'pb',.5),('c',266,'pc',1)]):
        b.append(f'<path d="M424 184L664 {y}" stroke="{LINE}" stroke-width="2"/>')
    b.append(text(544,142,'Server-Sent Events','mu',12,'middle',f'transform="rotate(-18 544 142)"'))
    for k,(y,kf,dly) in enumerate([(102,'pa',0),(184,'pb',.6),(266,'pc',1.2)]):
        cls='pulse cut' if k==0 else 'pulse'
        if k==0:
            b.append(f'<g class="cut"><circle class="pulse" style="animation-name:{kf};animation-delay:{dly}s" cx="428" cy="184" r="5" fill="{BRIGHT}"/></g>')
        else:
            b.append(f'<circle class="pulse" style="animation-name:{kf};animation-delay:{dly}s" cx="428" cy="184" r="5" fill="{BRIGHT}"/>')
    css+='@media (prefers-reduced-motion:reduce){.dg.first{opacity:1}}'
    return frame(1000,310,'Animated diagram: a timer actor runs on the server and streams updates to a laptop, a phone and a second tab. When the laptop closes the timer keeps running; when it reopens it is instantly back in sync. State is saved to SQLite.',css,''.join(b))

# ---- defense in depth -------------------------------------------------------------------
def security():
    gates=[('Browser','headers'),('Size and','time limits'),('Cross-site','check'),('Rate','limits'),('CSRF','token'),('Live signed','session'),('Owner','check')]
    GX=[186+i*94 for i in range(7)]
    attacks=[(1,'Oversized request','413 Too Large'),(2,'Cross-site POST from another page','403 Forbidden'),(3,'Password guessing','429 Too Many Requests'),(4,'Forged form with no token','403 Forbidden'),(5,'Stolen cookie, after the owner signed out','401 Unauthorized'),(6,'Asking for another user\'s task','404 Not Found')]
    per=2.6; total=per*(len(attacks)+1.4)
    pct=lambda s:s/total*100
    Y=170
    css=[]
    b=[text(24,32,'EVERY REQUEST PASSES EVERY LAYER','k',12)]
    b.append(f'<path d="M116 {Y}H882" stroke="{LINE}" stroke-width="3"/>')
    b.append(f'<rect x="24" y="{Y-34}" width="92" height="68" rx="6" fill="{PANEL}" stroke="{LINE}"/>'+text(70,Y-4,'The','h',13,'middle')+text(70,Y+14,'internet','h',13,'middle'))
    b.append(f'<rect x="866" y="{Y-54}" width="110" height="108" rx="6" fill="{PANEL}" stroke="{ACCENT}" stroke-width="2"/>'+text(921,Y-28,'Your data','h',13,'middle'))
    for i,l in enumerate(['bcrypt hashes','AES-256-GCM','tokens, private','database file']):
        b.append(text(921,Y-8+i*15,l,'mu',11,'middle'))
    for i,(x,(a,c)) in enumerate(zip(GX,gates)):
        b.append(f'<rect x="{x-7}" y="{Y-64}" width="14" height="128" rx="3" fill="{MEET}"/>')
        b.append(f'<rect id="g{i}" class="gf{i}" x="{x-7}" y="{Y-64}" width="14" height="128" rx="3" fill="{BAD}" opacity="0"/>')
        b.append(text(x,Y+84,a,'',12,'middle')+text(x,Y+100,c,'',12,'middle'))
    for n,(g,what,res) in enumerate(attacks):
        s=per*n; 
        x=GX[g]; dx=x-7-116
        a0,a1,a2,a3=pct(s),pct(s+per*.45),pct(s+per*.62),pct(s+per*.95)
        css.append(f'.a{n}{{animation:a{n} {total:.1f}s linear infinite both}}@keyframes a{n}{{0%,{a0:.2f}%{{opacity:0;transform:translateX(0)}}{a0+.3:.2f}%{{opacity:1;transform:translateX(0)}}{a1:.2f}%{{opacity:1;transform:translateX({dx}px)}}{a2:.2f}%{{opacity:0;transform:translateX({dx-26}px)}}100%{{opacity:0;transform:translateX({dx-26}px)}}}}')
        css.append(f'.gf{g}{{animation:gf{g} {total:.1f}s linear infinite}}@keyframes gf{g}{{0%,{a1-.2:.2f}%{{opacity:0}}{a1:.2f}%{{opacity:.95}}{a3:.2f}%{{opacity:0}}100%{{opacity:0}}}}')
        css.append(f'.t{n}{{animation:t{n} {total:.1f}s steps(1) infinite both}}@keyframes t{n}{{0%,{a0:.2f}%{{opacity:0}}{a0+.01:.2f}%,{a3:.2f}%{{opacity:1}}{a3+.01:.2f}%,100%{{opacity:0}}}}')
        b.append(f'<circle class="a{n}" cx="116" cy="{Y}" r="8" fill="{BAD}"/>')
        b.append(f'<g class="t{n}"><circle cx="30" cy="69" r="5" fill="{BAD}"/>'+text(44,74,what,'h',15)+text(976,74,res,'m',14,'end',f'style="fill:{BAD};font-size:14px"')+'</g>')
    s=per*len(attacks); a0,a1,a3=pct(s),pct(s+per*1.1),pct(s+per*1.35)
    css.append(f'.ok{{animation:ok {total:.1f}s linear infinite both}}@keyframes ok{{0%,{a0:.2f}%{{opacity:0;transform:translateX(0)}}{a0+.3:.2f}%{{opacity:1;transform:translateX(0)}}{a1:.2f}%{{opacity:1;transform:translateX(750px)}}{a3:.2f}%{{opacity:0;transform:translateX(750px)}}100%{{opacity:0;transform:translateX(750px)}}}}')
    css.append(f'.tok{{animation:tok {total:.1f}s steps(1) infinite both}}@keyframes tok{{0%,{a0:.2f}%{{opacity:0}}{a0+.01:.2f}%,{a3:.2f}%{{opacity:1}}{a3+.01:.2f}%,100%{{opacity:0}}}}')
    b.append(f'<circle class="ok" cx="116" cy="{Y}" r="8" fill="{GOOD}"/>')
    b.append(f'<g class="tok"><circle cx="30" cy="69" r="5" fill="{GOOD}"/>'+text(44,74,'You, signed in, reaching your own data','h',15)+text(976,74,'200 OK','m',14,'end',f'style="fill:{GOOD};font-size:14px"')+'</g>')
    css.append('@media (prefers-reduced-motion:reduce){'+','.join(f'.a{n},.t{n}' for n in range(len(attacks)))+',.ok{display:none}}')
    return frame(1000,296,'Animated diagram: requests pass seven layers on the way to your data. Oversized requests, cross-site posts, password guessing, forged forms, stolen cookies and requests for other users\' data are each stopped at a different layer, while a legitimate request reaches the data.',''.join(css),''.join(b))

# ---- charts: measured or real constants only ---------------------------------------------
POS,NEG='#c67d32','#4f9bdc'

def shine(paths, x0, x1, top, bottom):
    # A soft light passes over the bars. The bars themselves never animate, so every frame,
    # including the first, shows the real data.
    return (f'<defs><linearGradient id="sg"><stop offset="0" stop-color="#fff" stop-opacity="0"/>'
            f'<stop offset=".5" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
            f'<clipPath id="bars">{"".join(paths)}</clipPath></defs>'
            f'<g clip-path="url(#bars)"><rect class="sh" x="{x0-140}" y="{top}" width="140" height="{bottom-top}" fill="url(#sg)"/></g>'), (
            f'.sh{{animation:sh 7s ease-in-out infinite}}@keyframes sh{{0%{{transform:translateX(0)}}60%,100%{{transform:translateX({x1-x0+280}px)}}}}')
def chart_weights():
    rows=[('Your track record at that hour','historyFit',3.0),('How soon the task is due','urgency',2.0),('Deep work in your strongest hours','energyMatch',1.5),('The task\'s priority','priority',1.0),('Next to a block of the same task','contiguity',1.0),('Right after an hour of meetings','meetingAdjacency',-1.0),('Strands time another block could use','fragmentation',-1.5)]
    X0=372; unit=118; zero=X0+1.5*unit+12; top=88; step=34; bh=20
    paths=[]
    b=[text(24,34,'What the scheduler prefers','h',17),text(24,56,'Weights from score.go. Each signal is scored 0 to 1, then weighted; the best-scoring slot wins.',size=13)]
    # legend: two polarities
    b.append(f'<rect x="680" y="24" width="12" height="12" rx="2" fill="{POS}"/>'+text(698,34,'pulls a slot up',size=12.5)+f'<rect x="812" y="24" width="12" height="12" rx="2" fill="{NEG}"/>'+text(830,34,'pushes it down',size=12.5))
    b.append(f'<rect x="{zero:.0f}" y="{top-8}" width="1" height="{step*len(rows)+6}" fill="{MUTED}"/>')
    for i,(lab,key,v) in enumerate(rows):
        y=top+i*step
        b.append(text(24,y+15,lab,'',13.5,None,f'style="fill:{TEXT};font-size:13.5px"'))
        w=abs(v)*unit
        if v>=0:
            d=f'M{zero+2:.1f} {y}h{w-4:.1f}a4 4 0 0 1 4 4v{bh-8}a4 4 0 0 1-4 4h-{w-4:.1f}z'; paths.append(f'<path d="{d}"/>')
            b.append(f'<path d="{d}" fill="{POS}"/>')
            b.append(text(round(zero+w+10),y+15,f'+{v:.1f}','m',13,None,f'style="fill:{TEXT};font-size:13px"'))
        else:
            d=f'M{zero-2:.1f} {y}h-{w-4:.1f}a4 4 0 0 0-4 4v{bh-8}a4 4 0 0 0 4 4h{w-4:.1f}z'; paths.append(f'<path d="{d}"/>')
            b.append(f'<path d="{d}" fill="{NEG}"/>')
            b.append(text(round(zero-w-10),y+15,f'−{abs(v):.1f}','m',13,'end',f'style="fill:{TEXT};font-size:13px"'))
    mark,css=shine(paths,int(zero-1.5*unit),int(zero+3*unit),top,top+step*len(rows))
    b.append(mark)
    return frame(1000,top+step*len(rows)+14,'Bar chart of scheduler weights: track record +3.0, due soon +2.0, energy match +1.5, priority +1.0, contiguity +1.0, after meetings −1.0, fragmentation −1.5',css,''.join(b))

def chart_coverage(rows,total):
    X0=250; X1=900; top=84; step=30; bh=18
    paths=[]
    b=[text(24,34,'Backend test coverage by package','h',17),text(24,56,f'{total:.1f}% of statements overall. Measured across packages with go test -coverpkg. No hidden exclusions.',size=13)]
    for i,(n,v) in enumerate(rows):
        y=top+i*step
        b.append(text(24,y+14,n,'m',13,None,f'style="fill:{TEXT};font-size:13px"'))
        b.append(f'<rect x="{X0}" y="{y}" width="{X1-X0}" height="{bh}" rx="3" fill="{PANEL}"/>')
        w=(X1-X0)*v/100
        if w>=6:
            d=f'M{X0} {y}h{w-4:.1f}a4 4 0 0 1 4 4v{bh-8}a4 4 0 0 1-4 4h-{w-4:.1f}z'; paths.append(f'<path d="{d}"/>')
            b.append(f'<path d="{d}" fill="{POS}"/>')
        b.append(text(X1+12,y+14,f'{v:.1f}%','m',13,None,f'style="fill:{TEXT};font-size:13px"'))
    mark,css=shine(paths,X0,X1,top,top+step*len(rows))
    b.append(mark)
    return frame(1000,top+step*len(rows)+12,'Bar chart of backend test coverage by package; values are listed in the README table',css,''.join(b))

cov=json.loads((DATA/'coverage.json').read_text())
(OUT/'hero.svg').write_text(hero())
(OUT/'flow.svg').write_text(flow())
(OUT/'planner.svg').write_text(planner())
(OUT/'timer.svg').write_text(timer())
(OUT/'security.svg').write_text(security())
(OUT/'chart-weights.svg').write_text(chart_weights())
(OUT/'chart-coverage.svg').write_text(chart_coverage(cov['rows'],cov['total']))
print('written')
import xml.dom.minidom
for f in sorted(OUT.glob('*.svg')):
    xml.dom.minidom.parse(str(f))
print('all SVGs are well-formed XML')
