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
from .storage import Storage
from .bridge import NodeRunner
from .worker import Worker
from .lifecycle import Lifecycle
from .services import Services


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
        store=storage or Storage.from_settings(config);storage_ready=False
        if store:
            try:await asyncio.wait_for(asyncio.to_thread(store.verify_store),20);storage_ready=True
            except Exception:pass
        execution=runner or NodeRunner(config)
        runner_ready=True if runner else await execution.probe()
        application.state.storage=store
        worker=Worker(application.state.repo,config,store,execution)
        lifecycle=Lifecycle(application.state.repo,worker,store);worker.lifecycle=lifecycle
        application.state.worker=worker
        application.state.services=Services(application.state.repo,worker,lifecycle,store,storage_ready,runner_ready)
        await worker.start()
        try:
            yield
        finally:
            await worker.shutdown()
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
        service=application.state.services;available=service.storage_ready and service.runner_ready and service.worker.accepting
        discovery=bool(available and config.openrouter_api_key and config.openrouter_model)
        body={'ready':available,'db':'ready','storage':'ready' if service.storage_ready else 'unavailable','worker':'ready' if service.runner_ready else 'unavailable','discovery_available':discovery,'replay_available':available,'execution_location':config.environment,'handoff':'deferred'}
        return JSONResponse(body,status_code=200 if available else 503)
    return application


app=create_app()
