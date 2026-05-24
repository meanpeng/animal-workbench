import sys
sys.path.insert(0, r"D:\Code\animal_detection\workbench_app\app_backend")
from animal_workbench.main import app
print("Module loaded OK, routes:", len(app.routes))
# Check our endpoint exists
for route in app.routes:
    if "cleanup" in str(route.path):
        print(f"Found: {route.methods} {route.path}")
