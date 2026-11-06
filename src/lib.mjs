// Route Trace prototype: pure logic (no DOM, no network), unit-tested in test/lib.test.mjs.
// Probe matching, carrier families, line labels, hop geolocation fusion and path analysis.

// ---------- geometry ----------
const R = 6371;
export function km(a, b) {
  if (!a || !b) return Infinity;
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
// Light in fibre covers about 200 km per ms, so a round trip over d km takes at least d / 100 ms.
export const minRttFor = (d) => d / 100;
export const kmFor = (rtt) => rtt * 100;

// ---------- IP helpers ----------
export function v4(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip || '');
  return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4] : null;
}
function inCidr(n, cidr) {
  const [base, bits] = cidr.split('/'); const b = v4(base); const mask = bits == 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
}
const PRIVATE4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16'];
export function ipKind(ip) {
  if (!ip) return null;
  const n = v4(ip);
  if (n != null) {
    if (PRIVATE4.some((c) => inCidr(n, c))) return 'private';
    if (inCidr(n, '100.64.0.0/10')) return 'cgnat';
    return 'public';
  }
  const s = ip.toLowerCase();
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd') || s === '::1') return 'private';
  return 'public';
}

// ---------- carriers ----------
// Mainland carriers run dozens of provincial ASNs, so the family comes from the AS number when known, else from the
// network name (Globalping's probe "network", or the geo source's organisation).
const FAMILY_ASN = {
  'cn-telecom': [4134, 4809, 4811, 4812, 4813, 4816, 4835, 17638, 23650, 23724, 23764, 58466, 134756, 134760, 134761, 134762, 134763, 134764, 134765, 134766, 134767, 134768, 134769, 134770, 134771, 134772, 134773, 134774, 134775, 136188, 136190, 140292],
  'cn-unicom': [4837, 4808, 9929, 10099, 17621, 17622, 17623, 17816, 17816, 133118, 133119, 134542, 134543, 135061, 136958, 136959, 138421],
  'cn-mobile': [9808, 24400, 24444, 24445, 24547, 56040, 56041, 56042, 56044, 56045, 56046, 56047, 56048, 58453, 58807, 132525, 134810, 9394],
};
const FAMILY_NAME = [
  ['cn-telecom', /chinanet|china ?telecom|ctgnet|telecom.*china|cn2/i],
  ['cn-unicom', /unicom|china169|cncgroup|cuii|netcom/i],
  ['cn-mobile', /china ?mobile|cmnet|cmi\b|cmin2|tietong|crtc/i],
];
// the mainland carriers the page names (fam_<id> in the strings)
export const FAMILIES = ['cn-telecom', 'cn-unicom', 'cn-mobile'];
const ASN_FAMILY = new Map(Object.entries(FAMILY_ASN).flatMap(([f, l]) => l.map((a) => [a, f])));
export function family(asn, name) {
  if (asn && ASN_FAMILY.has(+asn)) return ASN_FAMILY.get(+asn);
  for (const [f, re] of FAMILY_NAME) if (re.test(name || '')) return f;
  return name ? 'n:' + normName(name) : null;
}
export function normName(name) {
  return String(name || '').toLowerCase().replace(/[,.()]/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|co|corp|corporation|company|communications?|group|gmbh|s a|sa|ag|bv|plc|technologies|technology)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ---------- exits ----------
// Same grouping as the 1ms.dog home page: one group per network (AS when known), so an ISP's IPv4 and IPv6 are one
// exit; data-centre networks are proxy exits. Home lines first, then the network most checks agree on.
export const DC_RE = /amazon|google|microsoft|azure|digitalocean|vultr|choopa|constant company|linode|akamai|ovh|hetzner|oracle|alibaba|aliyun|tencent|huawei|m247|datacamp|cloudflare|leaseweb|contabo|hostinger|it7|racknerd|colocrossing|psychz|zenlayer|g-core|gcore|hostwinds|scaleway|ionos|kamatera|upcloud|bandwagon|dmit|cogent|quadranet|servers\.com|packet|equinix|fastly|cdn77|datapacket|tzulo|hostdare|greencloud|nexeon|frantech|buyvm|hosting|vps|data ?cent/i;
const DC_ASN = new Set([16509, 14618, 15169, 396982, 8075, 13335, 45102, 37963, 45090, 132203, 55990, 14061, 20473, 63949, 16276, 24940, 31898, 9009, 212238, 54113, 20940]);
const fam6 = (x) => x.includes(':');
const v6g = (a) => { const [h, tl = ''] = a.toLowerCase().split('::'), H = h ? h.split(':') : [], T = tl ? tl.split(':') : []; return [...H, ...Array(Math.max(0, 8 - H.length - T.length)).fill('0'), ...T].map((g) => g.padStart(4, '0')); };
export const netOf = (x) => (fam6(x) ? v6g(x).slice(0, 4).join(':') : x.split('.').slice(0, 2).join('.'));
export function groupExits(seen, geo, zh = {}) {
  const geoOf = (ip) => geo[ip] || geo[Object.keys(geo).find((x) => fam6(x) === fam6(ip) && netOf(x) === netOf(ip))] || null;
  const G = [];
  for (const { ip, by } of seen) {
    const g0 = geoOf(ip); if (!g0) continue;   // shown once its network is known, so it never splits off and merges back
    const key = g0.asn ? 'as' + g0.asn : 'net' + netOf(ip);
    let g = G.find((x) => x.key === key);
    if (!g) { g = { key, ips: [], by: [], cc: '', city: '', asn: null, org: '', lat: null, lon: null, q: -1 }; G.push(g); }
    if (!g.ips.includes(ip)) g.ips.push(ip);
    if (!g.by.includes(by)) g.by.push(by);
    g.asn ||= g0.asn || null; g.org ||= g0.org || ''; g.cc ||= g0.cc || '';
    // the most trusted source's place wins
    if (g0.lat != null && (g0.q || 0) > g.q) { g.lat = g0.lat; g.lon = g0.lon; g.city = g0.city || g.city; g.region = g0.region; g.q = g0.q || 0; }
    if (zh[ip]) g.zh = zh[ip];   // ipip.net: [国家, 省, 市, '', 运营商], best for mainland lines
  }
  for (const g of G) {
    g.proxy = DC_ASN.has(g.asn) || DC_RE.test(g.org || '');
    g.ip = g.ips.find((x) => !fam6(x)) || g.ips[0];
    g.eyeball = !g.proxy;
    if (g.city && !CITY_ZH[g.city] && CITY_ZH[g.region]) g.city = g.region;
  }
  return G.filter((g) => g.lat != null).sort((a, b) => a.proxy - b.proxy || b.by.length - a.by.length);
}

// ---------- line labels ----------
// What a hop "is" in the words people use for routes: CN2, 163, CMI, 9929 and the big transit and cloud networks.
export const LINES = [
  { cidr: '59.43.0.0/16', asn: 4809, id: 'cn2', key: 'cn2', tone: 'premium' },
  { cidr: '202.97.0.0/16', id: '163', key: '163', tone: 'plain' },
  { asn: 23764, id: 'ctg', key: 'ctg', tone: 'premium' },
  { cidr: '219.158.0.0/16', id: '169', key: '169', tone: 'plain' },
  { cidr: '218.105.0.0/16', asn: 9929, id: '9929', key: '9929', tone: 'premium' },
  { cidr: '210.51.0.0/16', id: '9929', key: '9929', tone: 'premium' },
  { asn: 10099, id: 'cug', key: 'cug', tone: 'premium' },
  { cidr: '221.183.0.0/16', id: 'cmnet', key: 'cmnet', tone: 'plain' },
  { cidr: '221.176.0.0/16', id: 'cmnet', key: 'cmnet', tone: 'plain' },
  { asn: 58453, id: 'cmi', key: 'cmi', tone: 'plain' },
  { cidr: '223.118.0.0/15', id: 'cmi', key: 'cmi', tone: 'plain' },
  { cidr: '223.120.0.0/15', id: 'cmi', key: 'cmi', tone: 'plain' },
  { asn: 58807, id: 'cmin2', key: 'cmin2', tone: 'premium' },
  { asn: 4134, id: 'chinanet', key: 'chinanet', tone: 'plain' },
  { asn: 4837, id: 'unicom', key: 'unicom', tone: 'plain' },
  { asn: 9808, id: 'cmnet', key: 'cmnet', tone: 'plain' },
  { asn: 2914, label: 'NTT' }, { asn: 1299, label: 'Arelion (Telia)' }, { asn: 174, label: 'Cogent' },
  { asn: 3257, label: 'GTT' }, { asn: 3356, label: 'Lumen' }, { asn: 6939, label: 'Hurricane Electric' },
  { asn: 3491, label: 'PCCW' }, { asn: 4637, label: 'Telstra' }, { asn: 6453, label: 'Tata' },
  { asn: 6461, label: 'Zayo' }, { asn: 6762, label: 'Sparkle' }, { asn: 2516, label: 'KDDI' },
  { asn: 7473, label: 'Singtel' }, { asn: 9304, label: 'HGC' }, { asn: 4760, label: 'HKT' },
  { asn: 13335, label: 'Cloudflare' }, { asn: 15169, label: 'Google' }, { asn: 396982, label: 'Google Cloud' },
  { asn: 16509, label: 'AWS' }, { asn: 14618, label: 'AWS' }, { asn: 8075, label: 'Microsoft' },
  { asn: 32934, label: 'Meta' }, { asn: 20940, label: 'Akamai' }, { asn: 54113, label: 'Fastly' },
  { asn: 31898, label: 'Oracle Cloud' }, { asn: 45102, label: 'Alibaba Cloud' }, { asn: 37963, key: 'aliyun' },
  { asn: 45090, key: 'tencent' }, { asn: 132203, key: 'tencent' }, { asn: 55990, key: 'huawei' },
];
// Exchange points show up by name (an IX address is announced by nobody, so geo databases call it "Unknown").
const IX = [[/hkix/, 'HKIX'], [/equinix|eqix/, 'Equinix'], [/jpix/, 'JPIX'], [/jpnap/, 'JPNAP'], [/bbix/, 'BBIX'], [/de-?cix/, 'DE-CIX'],
  [/ams-?ix/, 'AMS-IX'], [/linx/, 'LINX'], [/sgix/, 'SGIX'], [/any2/, 'Any2']];
// Backbone links are often numbered from prefixes nobody announces in BGP, so they come with no AS; the registry (or a
// geo database's organisation) still names the carrier.
const ORG_LINES = [
  [/china unicom global|unicom-?hk|china unicom \(hong kong\)|cuhk/i, 10099],
  [/china telecom global|ctgnet|chinanet-?cn2|cn2/i, 4809],
  [/china mobile international|cmi-int/i, 58453],
];
export function lineOf(ip, asn, host, org, ix) {
  if (ix) return { id: 'ix:' + ix, ix, tone: 'ix' };
  if (host) { const h = host.toLowerCase(); for (const [re, name] of IX) if (re.test(h)) return { id: 'ix:' + name, ix: name, tone: 'ix' }; }
  const n = v4(ip);
  if (n != null) for (const l of LINES) if (l.cidr && inCidr(n, l.cidr)) return l;
  if (asn) for (const l of LINES) if (l.asn === +asn) return l;
  if (org) for (const [re, a] of ORG_LINES) if (re.test(org)) return LINES.find((l) => l.asn === a) || null;
  return null;
}

// ---------- probes ----------
// Probes have no id. Probes sharing country, city, AS and network type form one "slot": the API picks one of them at
// random, and a measurement's id pins the exact one for a re-run.
export function slotKey(p) {
  const l = p.location;
  return [l.country, l.city, l.asn, p.tags.includes('eyeball-network') ? 'e' : 'd'].join('|');
}
export function groupProbes(probes) {
  const m = new Map();
  for (const p of probes) {
    const k = slotKey(p); let s = m.get(k);
    if (!s) {
      const l = p.location;
      s = { key: k, cc: l.country, city: l.city, state: l.state, asn: l.asn, network: l.network,
        lat: l.latitude, lon: l.longitude, eyeball: p.tags.includes('eyeball-network'), count: 0,
        tags: new Set(), family: family(l.asn, l.network) };
      m.set(k, s);
    }
    s.count++;
    for (const t of p.tags) if (!t.startsWith('u-')) s.tags.add(t);
  }
  return [...m.values()].map((s) => ({ ...s, tags: [...s.tags] }));
}
export function locationFor(slot) {
  const loc = { country: slot.cc, city: slot.city, asn: slot.asn, tags: [slot.eyeball ? 'eyeball-network' : 'datacenter-network'], limit: 1 };
  return loc;
}

// How much a slot looks like "the network I am on": same AS beats same carrier beats nearby. `me` is
// { asn, org, lat, lon, cc, city, eyeball }. Returns a score and a tier the UI explains in words.
export function matchSlot(s, me) {
  const d = km(s, me);
  if (me.near) {
    // next to the target: distance decides; the same network only counts when it is also close
    const close = d < 1500, sameAsn = me.asn && s.asn === +me.asn, fam = family(me.asn, me.org), sameFam = !sameAsn && fam && s.family === fam;
    const sameCity = d < 60 || (me.city && s.city && s.city.toLowerCase() === me.city.toLowerCase() && s.cc === me.cc);
    const score = -Math.min(200, d / 40) + (sameCity ? 20 : 0) + (close && sameAsn ? 30 : close && sameFam ? 15 : 0) + (s.cc === me.cc ? 5 : 0) + (!s.eyeball ? 3 : 0);
    const tier = sameCity && sameAsn ? 'exact' : sameCity ? 'near-city' : d < 500 ? 'near' : d < 1500 ? 'region' : 'far';
    return { score, tier, km: d };
  }
  const sameAsn = me.asn && s.asn === +me.asn;
  const myFam = family(me.asn, me.org);
  const sameFam = !sameAsn && myFam && s.family === myFam;
  const sameCity = d < 60 || (me.city && s.city && s.city.toLowerCase() === me.city.toLowerCase() && s.cc === me.cc);
  // Carriers differ more than cities do (each runs its own backbone and border links), so the same carrier far away
  // beats another carrier next door.
  let score = 0;
  if (sameAsn) score += 70; else if (sameFam) score += 55;
  if (sameCity) score += 20; else if (d < 400) score += 10;
  if (s.cc === me.cc) score += 8;
  if (me.eyeball !== false && s.eyeball) score += 8;
  if (me.eyeball === false && !s.eyeball) score += 8;
  score -= Math.min(30, d / 100);
  const tier = sameAsn && sameCity ? 'exact' : sameAsn ? 'same-as' : sameFam && sameCity ? 'carrier-city'
    : sameFam ? 'carrier' : sameCity ? 'city' : d < 800 ? 'near' : 'far';
  return { score, tier, km: d };
}
export const TIER_GOOD = { exact: 3, 'same-as': 2, 'carrier-city': 2, carrier: 1, city: 1, near: 0, far: 0, 'near-city': 3, region: 1 };
export function rankSlots(slots, me) {
  return slots.map((s) => ({ s, m: matchSlot(s, me) })).sort((a, b) => b.m.score - a.m.score);
}

// ---------- search ----------
export const CITY_ZH = {
  Beijing: '北京', Shanghai: '上海', Guangzhou: '广州', Shenzhen: '深圳', Hangzhou: '杭州', Nanjing: '南京', Chengdu: '成都',
  Wuhan: '武汉', "Xi'an": '西安', Xian: '西安', Chongqing: '重庆', Tianjin: '天津', Suzhou: '苏州', Wuxi: '无锡', Changsha: '长沙',
  Zhengzhou: '郑州', Qingdao: '青岛', Jinan: '济南', Shenyang: '沈阳', Dalian: '大连', Harbin: '哈尔滨', Fuzhou: '福州',
  Xiamen: '厦门', Nanning: '南宁', Kunming: '昆明', Guiyang: '贵阳', Hefei: '合肥', Nanchang: '南昌', Shijiazhuang: '石家庄',
  Taiyuan: '太原', Lanzhou: '兰州', Urumqi: '乌鲁木齐', Hohhot: '呼和浩特', Dongguan: '东莞', Foshan: '佛山', Ningbo: '宁波',
  Wenzhou: '温州', Yancheng: '盐城', Wuhu: '芜湖', Jingzhou: '荆州', 'Tsuen Wan': '荃湾', 'Kwai Chung': '葵涌', Yokohama: '横滨',
  Taoyuan: '桃园', Hsinchu: '新竹', Busan: '釜山', Nagoya: '名古屋', Fukuoka: '福冈', Saitama: '埼玉', Chiba: '千叶', Guilin: '桂林', Shiyan: '十堰', Zhuhai: '珠海', Changzhou: '常州', Jiaxing: '嘉兴',
  'Hong Kong': '香港', Taipei: '台北', Kaohsiung: '高雄', Taichung: '台中', Macau: '澳门', Tokyo: '东京', Osaka: '大阪',
  Seoul: '首尔', Singapore: '新加坡', 'Los Angeles': '洛杉矶', 'San Jose': '圣何塞', 'San Francisco': '旧金山',
  Seattle: '西雅图', 'New York': '纽约', Chicago: '芝加哥', Dallas: '达拉斯', Ashburn: '阿什本', Fremont: '弗里蒙特',
  Frankfurt: '法兰克福', 'Frankfurt am Main': '法兰克福', London: '伦敦', Amsterdam: '阿姆斯特丹', Paris: '巴黎',
  Sydney: '悉尼', Melbourne: '墨尔本', Moscow: '莫斯科', 'Kuala Lumpur': '吉隆坡', Bangkok: '曼谷', Jakarta: '雅加达',
  'Ho Chi Minh City': '胡志明市', Hanoi: '河内', Manila: '马尼拉', Mumbai: '孟买', Dubai: '迪拜', Toronto: '多伦多',
  Vancouver: '温哥华', Berlin: '柏林', Madrid: '马德里', Milan: '米兰', Stockholm: '斯德哥尔摩', Warsaw: '华沙',
  'São Paulo': '圣保罗', Miami: '迈阿密', Atlanta: '亚特兰大', Phoenix: '凤凰城', 'Las Vegas': '拉斯维加斯',
  Denver: '丹佛', Portland: '波特兰', Boston: '波士顿', Washington: '华盛顿', Istanbul: '伊斯坦布尔', Johannesburg: '约翰内斯堡',
};
export function cityZh(c) { if (!c) return c; const k = String(c).replace(/[’`]/g, "'"); return CITY_ZH[k] || k; }
const FAMILY_WORDS = { 'cn-telecom': '电信 ct chinanet', 'cn-unicom': '联通 cu unicom', 'cn-mobile': '移动 cm cmcc mobile' };
export function haystack(s, countryName) {
  return [s.city, CITY_ZH[s.city], s.cc, countryName, s.network, 'as' + s.asn, String(s.asn),
    FAMILY_WORDS[s.family] || '', s.eyeball ? '家宽 家庭 eyeball home' : '机房 数据中心 datacenter dc idc', ...s.tags]
    .filter(Boolean).join(' ').toLowerCase();
}
// Every space-separated term must match somewhere ("上海 电信", "as4134", "tokyo aws").
export function matches(hay, q) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => hay.includes(t));
}

// ---------- hop geolocation ----------
// Router names often carry a city code (IATA or the CLLI-style codes transit networks use). A hit beats a geo database.
const HINTS = {
  hkg: ['Hong Kong', 22.31, 114.17], hongkong: ['Hong Kong', 22.31, 114.17], hnkg: ['Hong Kong', 22.31, 114.17], hkng: ['Hong Kong', 22.31, 114.17],
  tyo: ['Tokyo', 35.68, 139.69], nrt: ['Tokyo', 35.68, 139.69], hnd: ['Tokyo', 35.68, 139.69], toky: ['Tokyo', 35.68, 139.69], tokyo: ['Tokyo', 35.68, 139.69],
  osa: ['Osaka', 34.69, 135.5], kix: ['Osaka', 34.69, 135.5], osak: ['Osaka', 34.69, 135.5],
  sin: ['Singapore', 1.35, 103.82], sng: ['Singapore', 1.35, 103.82], sngp: ['Singapore', 1.35, 103.82], sinp: ['Singapore', 1.35, 103.82],
  icn: ['Seoul', 37.57, 126.98], sel: ['Seoul', 37.57, 126.98], seol: ['Seoul', 37.57, 126.98],
  tpe: ['Taipei', 25.03, 121.57], tpe1: ['Taipei', 25.03, 121.57],
  lax: ['Los Angeles', 34.05, -118.24], lsan: ['Los Angeles', 34.05, -118.24], losangeles: ['Los Angeles', 34.05, -118.24],
  sjc: ['San Jose', 37.34, -121.89], snjs: ['San Jose', 37.34, -121.89], sanjose: ['San Jose', 37.34, -121.89],
  sfo: ['San Francisco', 37.77, -122.42], pao: ['Palo Alto', 37.44, -122.14], fmt: ['Fremont', 37.55, -121.99],
  sea: ['Seattle', 47.61, -122.33], sttl: ['Seattle', 47.61, -122.33],
  nyc: ['New York', 40.71, -74.0], jfk: ['New York', 40.71, -74.0], ewr: ['New York', 40.71, -74.0], nycm: ['New York', 40.71, -74.0], nwyy: ['New York', 40.71, -74.0],
  iad: ['Ashburn', 39.04, -77.49], ash: ['Ashburn', 39.04, -77.49], asbn: ['Ashburn', 39.04, -77.49], wdc: ['Washington', 38.9, -77.04],
  chi: ['Chicago', 41.88, -87.63], ord: ['Chicago', 41.88, -87.63], chcg: ['Chicago', 41.88, -87.63],
  dfw: ['Dallas', 32.78, -96.8], dal: ['Dallas', 32.78, -96.8], dlls: ['Dallas', 32.78, -96.8],
  mia: ['Miami', 25.76, -80.19], atl: ['Atlanta', 33.75, -84.39], den: ['Denver', 39.74, -104.99],
  fra: ['Frankfurt', 50.11, 8.68], frnk: ['Frankfurt', 50.11, 8.68], ffm: ['Frankfurt', 50.11, 8.68],
  ams: ['Amsterdam', 52.37, 4.9], amst: ['Amsterdam', 52.37, 4.9],
  lon: ['London', 51.51, -0.13], lhr: ['London', 51.51, -0.13], lond: ['London', 51.51, -0.13], ldn: ['London', 51.51, -0.13],
  par: ['Paris', 48.86, 2.35], cdg: ['Paris', 48.86, 2.35], pari: ['Paris', 48.86, 2.35],
  syd: ['Sydney', -33.87, 151.21], sydn: ['Sydney', -33.87, 151.21], mel: ['Melbourne', -37.81, 144.96],
  bom: ['Mumbai', 19.08, 72.88], dxb: ['Dubai', 25.2, 55.27], kul: ['Kuala Lumpur', 3.14, 101.69],
  bkk: ['Bangkok', 13.76, 100.5], mow: ['Moscow', 55.76, 37.62], waw: ['Warsaw', 52.23, 21.01], sto: ['Stockholm', 59.33, 18.07],
  mrs: ['Marseille', 43.3, 5.37], mad: ['Madrid', 40.42, -3.7], mil: ['Milan', 45.46, 9.19], yyz: ['Toronto', 43.65, -79.38], tor: ['Toronto', 43.65, -79.38],
  gru: ['São Paulo', -23.55, -46.63],
  hkix: ['Hong Kong', 22.31, 114.17], jpix: ['Tokyo', 35.68, 139.69], jpnap: ['Tokyo', 35.68, 139.69], sgix: ['Singapore', 1.35, 103.82],
  linx: ['London', 51.51, -0.13], amsix: ['Amsterdam', 52.37, 4.9],
};
// coordinates for a city we know by name (an exchange's city from PeeringDB)
export function cityPoint(city) {
  const c = String(city || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const [k, [name, lat, lon]] of Object.entries(HINTS)) if (name.toLowerCase().replace(/[^a-z]/g, '') === c) return { city: name, lat, lon };
  return null;
}
export function hostnameHint(name) {
  if (!name) return null;
  const tokens = String(name).toLowerCase().split(/[.\-_]/);
  for (const t of tokens) {
    const bare = t.replace(/\d+$/, '');
    for (const k of [t, bare, bare.slice(0, 4)]) {
      if (k.length >= 3 && HINTS[k]) { const [city, lat, lon] = HINTS[k]; return { city, lat, lon, src: 'hostname' }; }
    }
  }
  return null;
}
// Geo databases put addresses they only know the country of at the country's centre, with no city.
export const realAsn = (a) => { const n = +a; return n > 0 && !(n >= 64512 && n <= 65535) && n < 4200000000 && n !== 23456 ? n : null; };
export function geoFromDb(g) {
  if (!g || g.latitude == null) return null;
  const lat = +g.latitude, lon = +g.longitude;
  if (!isFinite(lat) || !isFinite(lon)) return null;
  // GeoJS sometimes names a district (Beijing's "Chaowai"); the region reads better when it's a city we know
  const raw = g.city ? String(g.city).replace(/[’`]/g, "'") : null;
  const city = raw && !CITY_ZH[raw] && CITY_ZH[g.region] ? g.region : raw;
  const org = g.organization_name && !/^unknown$/i.test(g.organization_name) ? g.organization_name : null;
  return { city: city || null, cc: g.country_code || null, lat, lon, src: g.city ? 'city' : 'country', org, asn: realAsn(g.asn) };
}

// ---------- path analysis ----------
// Routers answer traceroute probes on a slow path, so one hop's own RTT can be higher than the hops after it. The real
// latency up to hop i can't be more than any later hop's best RTT (those packets passed hop i), so the floor is the
// minimum over the hop's own best RTT and every later one.
export function floors(hops) {
  const out = new Array(hops.length).fill(null); let run = Infinity;
  for (let i = hops.length - 1; i >= 0; i--) {
    const m = hops[i].stats?.min;
    if (m != null && hops[i].stats.rcv > 0) run = Math.min(run, m);
    out[i] = isFinite(run) ? run : null;
  }
  return out;
}

// hops: Globalping MTR hops. probe: result.probe. geo: Map ip -> {city, cc, lat, lon, src, org}.
export function analyze(hops, probe, geo = new Map()) {
  const origin = { lat: probe.latitude, lon: probe.longitude, city: probe.city, cc: probe.country };
  const fl = floors(hops);
  const out = hops.map((h, i) => {
    const ip = h.resolvedAddress; const kind = ipKind(ip);
    const g = ip ? geo.get(ip) : null;
    // Globalping's AS comes from BGP; backbone addresses nobody announces have none, so the geo source's (or the
    // registry's) stands in
    const bgp = h.asn?.[0] || null, asn = bgp || g?.asn || realAsn((/\bAS(\d{2,10})\b/.exec(g?.regOrg || '') || [])[1]) || null;
    const ok = h.stats && h.stats.rcv > 0;
    let loc = null;
    if (kind === 'private' || kind === 'cgnat') loc = { ...origin, src: 'local' };
    else if (ip) {
      const hint = (g?.src === 'ix' && g.lat != null ? g : null) || hostnameHint(h.resolvedHostname);
      loc = hint || (g?.lat != null ? g : null);
      // For an unannounced address, a geo database only knows where the block is registered (China Unicom Global's
      // links are registered in Hong Kong, wherever the router stands), so that place is a guess, not a city
      if (!hint && loc && !bgp && loc.src === 'city') loc = { ...loc, src: 'registry' };
    }
    if (loc && loc.src !== 'local' && fl[i] != null) {
      // a hop can't be farther away than its round trip lets light travel (plus slack for the probe's own position)
      const d = km(origin, loc);
      if (d > kmFor(fl[i]) + 300) loc = { ...loc, implausible: true };
    }
    // a public hop within 3 ms of the probe is in the probe's city, whatever a database says
    if (kind === 'public' && fl[i] != null && fl[i] < 3 && (!loc || loc.implausible || loc.src === 'country' || loc.src === 'registry')) {
      loc = { ...origin, cc: probe.country, src: 'rtt' };
    }
    return {
      n: i + 1, ip, host: h.resolvedHostname && h.resolvedHostname !== ip ? h.resolvedHostname : null, kind, asn,
      org: g?.org || null, line: ip ? lineOf(ip, asn, h.resolvedHostname, [g?.org, g?.regOrg].filter(Boolean).join(' '), g?.ix) : null, ok, ix: g?.ix ? { name: g.ix, member: g.member } : null,
      min: h.stats?.min ?? null, avg: h.stats?.avg ?? null, max: h.stats?.max ?? null, jAvg: h.stats?.jAvg ?? null,
      loss: h.stats?.loss ?? 100, sent: h.stats?.total ?? 0, floor: fl[i], loc,
    };
  });

  // trailing silent hops (the target ignores probes) aren't part of the path
  let end = out.length; while (end > 0 && !out[end - 1].ok) end--;
  const path = out.slice(0, end);
  const last = path[path.length - 1] || null;
  const reached = !!(last && out.length && last === out[out.length - 1]);

  // The probe's own LAN (private and CGNAT hops before the first public one, and silent hops among them) is the
  // probe's, not the path's: it's left out of the segments and their costs, which start from where it ends.
  let firstPub = path.findIndex((h) => h.ok && h.kind === 'public');
  if (firstPub < 0) firstPub = path.length;
  const local = path.slice(0, firstPub);
  const localFloor = local.filter((h) => h.ok && h.floor != null).map((h) => h.floor).pop() ?? 0;
  // owners: consecutive hops of one network form a segment; silent or private hops join their neighbour
  const segs = [];
  for (const h of path.slice(firstPub)) {
    const owner = h.kind === 'private' || h.kind === 'cgnat' ? 'local'
      : h.line?.id || (h.asn ? 'as' + h.asn : null);
    const cur = segs[segs.length - 1];
    if (!owner || (cur && cur.owner === owner)) { if (cur) cur.hops.push(h); else segs.push({ owner: owner || 'unknown', hops: [h] }); continue; }
    segs.push({ owner, hops: [h] });
  }
  let prevFloor = localFloor;
  for (const s of segs) {
    const resp = s.hops.filter((h) => h.ok && h.floor != null);
    const h0 = s.hops.find((h) => h.asn || h.line) || s.hops[0];
    s.asn = h0.asn; s.line = h0.line; s.org = h0.org;
    // carriers by the name people use (中国联通, not China Unicom Beijing Province Network)
    const fam = family(h0.asn, h0.org);
    s.name = s.owner === 'local' ? { local: true } : s.line ? { line: s.line } : FAMILIES.includes(fam) ? { fam } : h0.org ? { org: h0.org } : s.asn ? { asn: s.asn } : { unknown: true };
    if (s.owner === 'unknown' && h0.asn) { s.owner = 'as' + h0.asn; }
    else if (s.owner === 'unknown' && s === segs[0]) { s.asn = probe.asn; s.line = lineOf('', probe.asn); s.name = s.line ? { line: s.line } : probe.network ? { org: probe.network } : s.name; }
    s.start = prevFloor; s.end = resp.length ? resp[resp.length - 1].floor : prevFloor;
    s.cost = Math.max(0, s.end - s.start); prevFloor = Math.max(prevFloor, s.end);
    const locs = s.hops.map((h) => h.loc).filter((l) => l && !l.implausible && l.src !== 'country' && l.src !== 'registry');
    s.place = locs.length ? locs[locs.length - 1].city : null;
  }

  // jumps: where the floor rises most from one answering hop to the next
  const jumps = []; let prev = null;
  for (const h of path.slice(firstPub)) {
    if (!h.ok || h.floor == null) continue;
    if (prev) {
      const d = h.floor - prev.floor;
      if (d >= 15) {
        const a = prev.loc && !prev.loc.implausible && prev.loc.src !== 'country' && prev.loc.src !== 'registry' ? prev.loc : null;
        const b = h.loc && !h.loc.implausible && h.loc.src !== 'country' && h.loc.src !== 'registry' ? h.loc : null;
        const dist = a && b ? km(a, b) : null;
        jumps.push({ from: prev, to: h, ms: d, dist, expect: dist != null ? minRttFor(dist) : null, a });
      }
    }
    prev = h;
  }
  jumps.sort((x, y) => y.ms - x.ms);

  // A big jump that matches the fibre round trip from the hop before it to a far place seen later on the path means
  // the traffic went there; hops after the jump that a geo database still puts near the old place are then wrong.
  const good = (l) => l && !l.implausible && l.src !== 'country' && l.src !== 'registry' && l.src !== 'local';
  for (const j of jumps) {
    // crossing into another country: the first place known at or after the jump (a country is enough)
    if (j.a?.cc) {
      const next = path.find((h) => h.n >= j.to.n && h.loc && !h.loc.implausible && h.loc.cc && h.loc.src !== 'registry' && h.loc.src !== 'local' && h.loc.src !== 'rtt');
      if (next && next.loc.cc !== j.a.cc) { const d = km(j.a, next.loc); j.into = { cc: next.loc.cc, km: d, rtt: minRttFor(d) }; }
    }
    if (!j.a || j.ms < 40) continue;
    const later = path.filter((h) => h.n >= j.to.n && good(h.loc));
    const far = later.map((h) => ({ h, d: km(j.a, h.loc) })).filter((x) => x.d > 1500)
      .find((x) => Math.abs(minRttFor(x.d) - j.ms) <= Math.max(15, j.ms * 0.35));
    if (!far) continue;
    j.far = { ...far.h.loc, km: far.d, rtt: minRttFor(far.d), later: far.h !== j.to };
    for (const h of later) if (km(j.a, h.loc) < 500 && h.floor >= j.from.floor + j.ms * 0.6) h.loc = { ...h.loc, implausible: true, movedTo: far.h.loc.city };
  }
  for (const s of segs) {
    const locs = s.hops.map((h) => h.loc).filter(good);
    s.place = locs.length ? locs[locs.length - 1].city : null;
  }

  // loss: what reaches the last answering hop is the path's loss; a hop that drops replies while later hops don't is
  // only rate-limiting its answers
  const realLoss = last ? last.loss : null;
  const limited = path.filter((h, i) => h.ok && h.kind === 'public' && h.loss > 0 && path.slice(i + 1).some((x) => x.ok && x.loss < h.loss * 0.5));
  let lossFrom = null;
  if (realLoss > 0) {
    for (let i = path.length - 1; i >= 0; i--) { if (!path[i].ok) continue; if (path[i].loss >= realLoss * 0.6) lossFrom = path[i]; else break; }
  }

  // border: first located hop outside the probe's country
  const cross = jumps.find((j) => j.into && j.from.floor != null);
  const border = cross ? cross.to : path.find((h) => h.loc && !h.loc.implausible && h.loc.cc && origin.cc && h.loc.cc !== origin.cc && h.loc.src !== 'local' && h.loc.src !== 'registry') || null;

  const destLoc = last?.loc && !last.loc.implausible && last.loc.src !== 'country' ? last.loc : null;
  const directKm = destLoc ? km(origin, destLoc) : null;
  return {
    borderCc: cross ? cross.into.cc : border?.loc?.cc || null,
    origin, hops: out, path, local, localFloor, segs, jumps, reached, last, realLoss, limited, lossFrom, border,
    total: last?.floor ?? null, avg: last?.avg ?? null, jitter: last?.jAvg ?? null,
    directKm, physMin: directKm != null ? minRttFor(directKm) : null,
  };
}
