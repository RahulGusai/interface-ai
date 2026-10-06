import asyncio
import fcntl
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware
from .config import Settings
from .db import Database
from .repositories import Repository
from .errors import install_errors
from .api import router


class RuntimeCORS:
    def __init__(self,app,get_settings):self.app,self.get_settings=app,get_settings
    async def __call__(self,scope,receive,send):
        settings=self.get_settings()
        middleware=CORSMiddleware(self.app,allow_origins=settings.cors_origins if settings else [],allow_credentials=False,allow_methods=['GET','POST','PATCH','OPTIONS'],allow_headers=['Content-Type','Idempotency-Key'])
        await middleware(scope,receive,send)


def create_app(settings:Settings|None=None,storage=None,runner=None):
    @asynccontextmanager
    async def lifespan(application):
        config=settings or Settings()
        application.state.settings=config
        db=Database(config.database_path)
        await asyncio.to_thread(db.migrate)
        lock=(config.database_path.parent/'service.lock').open('a')
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close();raise RuntimeError('Only one API process may own this database')
        application.state.repo=Repository(db)
        application.state.storage=storage
        application.state.worker=None
        try:
            yield
        finally:
            fcntl.flock(lock,fcntl.LOCK_UN);lock.close()
    application=FastAPI(title='Interface AI control API',version='1.0.0',lifespan=lifespan)
    application.state.settings=settings
    application.add_middleware(RuntimeCORS,get_settings=lambda:application.state.settings)
    install_errors(application)
    application.include_router(router)

    @application.get('/health/live')
    async def live():return {'status':'alive'}

    @application.get('/health/ready')
    async def ready():
        config=application.state.settings
        body={'ready':False,'db':'ready','storage':'unavailable','worker':'unavailable','discovery_available':False,'replay_available':False,'execution_location':config.environment,'handoff':'deferred'}
        return JSONResponse(body,status_code=503)
    return application


app=create_app()
