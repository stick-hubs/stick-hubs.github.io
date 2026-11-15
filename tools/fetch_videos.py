"""Reads akami's public YouTube feed and writes videos.json for the Stick Manx TV page."""
import json, urllib.request, xml.etree.ElementTree as ET
CH = "UClzHoLfcBaqITCXTcFmtb9Q"
NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015", "m": "http://search.yahoo.com/mrss/"}
req = urllib.request.Request(f"https://www.youtube.com/feeds/videos.xml?channel_id={CH}", headers={"User-Agent": "Mozilla/5.0"})
root = ET.fromstring(urllib.request.urlopen(req, timeout=30).read())
vids = []
for e in root.findall("a:entry", NS):
    g = e.find("m:group", NS)
    st = g.find("m:community/m:statistics", NS) if g is not None else None
    vid = e.findtext("yt:videoId", "", NS)
    link = e.find("a:link", NS)
    vids.append({
        "id": vid,
        "title": e.findtext("a:title", "", NS),
        "published": e.findtext("a:published", "", NS),
        "views": int(st.get("views", 0)) if st is not None else 0,
        "description": (g.findtext("m:description", "", NS) if g is not None else "")[:500],
        "short": bool(link is not None and "/shorts/" in link.get("href", "")),
    })
out = json.dumps({"channel": CH, "videos": vids}, ensure_ascii=False, indent=1)
try:
    old = open("videos.json", encoding="utf-8").read()
except FileNotFoundError:
    old = ""
if out != old:
    open("videos.json", "w", encoding="utf-8").write(out)
print(len(vids), "videos")
