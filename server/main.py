from server.app import app
from server.local_files import router as local_lidar_router

app.include_router(local_lidar_router)
