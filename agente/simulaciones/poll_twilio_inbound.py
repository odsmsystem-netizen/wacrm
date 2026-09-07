# Sondea la API de Twilio (no el webhook local) para detectar mensajes
# entrantes nuevos al número de sandbox — el "join <codigo>" lo procesa
# Twilio internamente y NUNCA llega a nuestro webhook, así que hay que
# verlo directo en el historial de mensajes de Twilio.
import os
import time
import requests
from dotenv import load_dotenv

load_dotenv()
SID = os.getenv("TWILIO_ACCOUNT_SID")
TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
URL = f"https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json"

vistos = set()

# Primera pasada: marca como "ya vistos" los mensajes existentes, para
# solo reportar los que lleguen DESPUÉS de arrancar este script.
r = requests.get(URL, params={"To": "whatsapp:+14155238886", "PageSize": 20}, auth=(SID, TOKEN))
for m in r.json().get("messages", []):
    vistos.add(m["sid"])

while True:
    time.sleep(8)
    try:
        r = requests.get(URL, params={"To": "whatsapp:+14155238886", "PageSize": 20}, auth=(SID, TOKEN))
        for m in r.json().get("messages", []):
            if m["sid"] in vistos:
                continue
            vistos.add(m["sid"])
            etiqueta = "JOIN" if m["body"].strip().lower().startswith("join") else "MENSAJE"
            print(f"{etiqueta} | {m['date_created']} | {m['from']} -> {m['to']} | {m['body']!r} | status={m['status']}")
    except Exception as exc:
        print(f"AVISO: error consultando Twilio (se sigue intentando): {exc}")
