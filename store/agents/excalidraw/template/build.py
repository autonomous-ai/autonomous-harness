"""The starter diagram, as a script — edit and run: python3 build.py
Delete this file when you write scenes by hand or from another name."""
from scene import Scene

s = Scene()
s.title("How a request moves", 0, -110)
client = s.box(0, 0, "Browser", color="gray")
api = s.box(300, 0, "API", color="blue")
db = s.box(600, 0, "Postgres", color="green", shape="ellipse")
queue = s.box(300, 180, "Queue", color="yellow", shape="diamond")
worker = s.box(600, 180, "Worker", color="purple")
s.arrow(client, api, "HTTPS")
s.arrow(api, db, "SQL")
s.arrow(api, queue, "job", dashed=True)
s.arrow(queue, worker)
s.arrow(worker, db, "writes", dashed=True)
s.frame([api, db, queue, worker], "Backend")
s.save("diagram.excalidraw")
print("diagram.excalidraw")
