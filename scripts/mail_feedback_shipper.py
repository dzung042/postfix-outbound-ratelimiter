#!/usr/bin/env python3
"""
Sample MTA log shipper for the ratelimit-policyd bounce-rate feedback loop (B).

Tails a Postfix/PMG mail log, correlates queue-id -> envelope sender, and POSTs
delivery outcomes (sent/bounced/deferred + dsn) to the policy service ingest API.
The service turns these into per-sender bounce/spam rates and (in enforce mode)
auto-suspends senders whose reputation goes bad.

This is a REFERENCE implementation - adapt the regexes to your log format.
Dependencies: Python 3 stdlib only.

Usage:
  FEEDBACK_URL=http://policyd:8080/api/feedback/delivery \\
  FEEDBACK_TOKEN=xxxxx \\
  MAIL_LOG=/var/log/mail.log \\
  python3 mail_feedback_shipper.py
"""
import json
import os
import re
import time
import urllib.request
from collections import OrderedDict

FEEDBACK_URL = os.environ.get("FEEDBACK_URL", "http://127.0.0.1:8080/api/feedback/delivery")
FEEDBACK_TOKEN = os.environ.get("FEEDBACK_TOKEN", "")
MAIL_LOG = os.environ.get("MAIL_LOG", "/var/log/mail.log")
BATCH_MAX = int(os.environ.get("BATCH_MAX", "50"))
FLUSH_SECS = float(os.environ.get("FLUSH_SECS", "5"))

# Postfix lines we care about:
#   ...qmgr...: <QID>: from=<addr>, size=..., nrcpt=...
#   ...smtp...: <QID>: to=<addr>, ... dsn=5.1.1, status=bounced (...)
RE_FROM = re.compile(r"\b([0-9A-F]{6,}|[0-9a-z]{10,}): from=<([^>]*)>")
RE_DELIV = re.compile(
    r"\b([0-9A-F]{6,}|[0-9a-z]{10,}): to=<([^>]*)>.*?"
    r"(?:dsn=(\d+\.\d+\.\d+))?.*?status=(\w+)(?:\s*\(([^)]*)\))?"
)

# qid -> sender, bounded LRU so memory stays flat.
qid_sender = OrderedDict()
QID_MAX = 50000


def remember(qid, sender):
    qid_sender[qid] = sender
    qid_sender.move_to_end(qid)
    while len(qid_sender) > QID_MAX:
        qid_sender.popitem(last=False)


def post(events):
    if not events:
        return
    body = json.dumps({"events": events}).encode()
    req = urllib.request.Request(
        FEEDBACK_URL, data=body, method="POST",
        headers={"content-type": "application/json", "x-feedback-token": FEEDBACK_TOKEN},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            r.read()
    except Exception as e:  # never crash the shipper on a transient API error
        print("[shipper] post failed:", e, flush=True)


def follow(path):
    """Tail -F: reopen on truncation/rotation."""
    while True:
        try:
            f = open(path, "r", errors="replace")
        except FileNotFoundError:
            time.sleep(2)
            continue
        f.seek(0, os.SEEK_END)
        inode = os.fstat(f.fileno()).st_ino
        while True:
            line = f.readline()
            if line:
                yield line
                continue
            time.sleep(0.2)
            try:
                if os.stat(path).st_ino != inode:
                    f.close()
                    break  # rotated -> reopen
            except FileNotFoundError:
                f.close()
                break


def main():
    if not FEEDBACK_TOKEN:
        print("[shipper] FEEDBACK_TOKEN not set; refusing to start", flush=True)
        raise SystemExit(1)
    batch = []
    last = time.time()
    for line in follow(MAIL_LOG):
        m = RE_FROM.search(line)
        if m:
            remember(m.group(1), m.group(2).lower())
        m = RE_DELIV.search(line)
        if m:
            qid, _to, dsn, status, text = m.groups()
            sender = qid_sender.get(qid)
            if sender:
                batch.append({
                    "sender": sender, "queueId": qid,
                    "status": status or "", "dsn": dsn or "", "text": text or "",
                })
        if len(batch) >= BATCH_MAX or (batch and time.time() - last >= FLUSH_SECS):
            post(batch)
            batch = []
            last = time.time()


if __name__ == "__main__":
    main()
