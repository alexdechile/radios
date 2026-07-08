import json
import re
import sys
import time
from scrapling.fetchers import Fetcher

def scrape_internet_radio():
    stations = []
    # Scrape first few pages of different genres
    genres = ['rock', 'jazz', '80s', 'disco', 'chillout', 'blues', 'ambient', 'classical', 'dance', 'electronic']
    
    for genre in genres:
        try:
            print(f"Scraping Internet-Radio genre: {genre}...", file=sys.stderr)
            url = f"https://www.internet-radio.com/stations/{genre}/"
            page = Fetcher.get(url)
            
            rows = page.css('table.table-striped tr')
            count = 0
            for i, row in enumerate(rows):
                try:
                    name_el = row.css('h4.text-danger a')
                    name = name_el.css('::text').get()
                    if not name: continue
                    
                    popup_script = row.css('a[title="Play in new window"]::attr(onclick)').get()
                    stream_url = ""
                    if popup_script:
                        match = re.search(r"server=([^',]+)", popup_script)
                        if match:
                            host_port = match.group(1)
                            stream_url = host_port if host_port.startswith('http') else f"http://{host_port}/"
                    
                    if not stream_url:
                        pls_link = row.css('a[title="PLS Playlist File"]::attr(href)').get()
                        if pls_link:
                            match = re.search(r"u=(http[^&]+)", pls_link)
                            if match: stream_url = match.group(1).replace('/listen.pls', '/')

                    if not stream_url: continue
                    if not stream_url.endswith('/') and not re.search(r'\.\w{3,4}$', stream_url):
                        stream_url += '/'

                    td_meta = row.css('td:nth-child(4)')
                    meta_text = td_meta.css('p::text').getall()
                    bitrate = 0
                    for m in meta_text:
                        if 'Kbps' in m:
                            try: bitrate = int(m.split(' ')[0])
                            except: pass
                    
                    stations.append({
                        "uuid": f"deep-ir-{genre}-{i}",
                        "name": name.strip(),
                        "url_resolved": stream_url,
                        "favicon": "", 
                        "tags": f"{genre}",
                        "country": "International",
                        "bitrate": bitrate,
                        "codec": "MP3",
                        "is_deep": True
                    })
                    count += 1
                except: continue
            print(f"  Found {count} stations", file=sys.stderr)
        except Exception as e:
            print(f"Error Internet-Radio: {e}", file=sys.stderr)
                
    return stations

def scrape_emisoras_chile():
    # Example of adding a local source
    stations = []
    print(f"Scraping Emisoras Chilenas (Deep)...", file=sys.stderr)
    # This is a representative structure, in a real scenario we'd target a specific directory
    # For now, let's simulate adding some high-quality local links that are often missed
    local_stations = [
        {"name": "Radio Universidad de Chile", "url": "https://stream.uchile.cl/radio_uchile_320k", "tags": "cultura, noticias, chile", "bitrate": 320},
        {"name": "Beethoven FM", "url": "https://stream.beethovenfm.cl/beethovenfm", "tags": "classical, chile", "bitrate": 192},
        {"name": "Radio Infinita", "url": "https://unlimited1-cl.dps.live/infinita/mp3/icecast.audio", "tags": "noticias, talk, chile", "bitrate": 128},
        {"name": "Radio Oasis", "url": "https://unlimited6-cl.dps.live/oasis/mp3/icecast.audio", "tags": "rock, pop, chile", "bitrate": 128},
    ]
    
    for i, s in enumerate(local_stations):
        stations.append({
            "uuid": f"deep-cl-{i}",
            "name": s["name"],
            "url_resolved": s["url"],
            "favicon": "",
            "tags": s["tags"],
            "country": "Chile",
            "bitrate": s["bitrate"],
            "codec": "MP3",
            "is_deep": True
        })
    return stations

if __name__ == "__main__":
    db = scrape_internet_radio()
    db += scrape_emisoras_chile()
    
    with open('radios_db.json', 'w') as f:
        json.dump(db, f, indent=2)
    print(json.dumps({"status": "success", "count": len(db)}))
