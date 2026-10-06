from uuid import uuid4
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError


class ApiError(Exception):
    def __init__(self, status, code, message, details=None, retryable=False):
        self.status,self.code,self.message,self.details,self.retryable=status,code,message,details,retryable


def envelope(error):
    return {'error':{'code':error.code,'message':error.message,'details':error.details or {},'retryable':error.retryable},'request_id':str(uuid4())}


def install_errors(app):
    @app.exception_handler(ApiError)
    async def api_error(request,error):
        return JSONResponse(envelope(error),status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def validation(request,error):
        fields=[{'path':'.'.join(str(x) for x in e['loc'] if x!='body'),'code':e['type'],'message':'Invalid field'} for e in error.errors()]
        return JSONResponse(envelope(ApiError(422,'REQUEST_INVALID','Request fields are invalid',{'fields':fields})),status_code=422)

    @app.exception_handler(Exception)
    async def unexpected(request,error):
        return JSONResponse(envelope(ApiError(500,'INTERNAL_ERROR','Unable to complete request')),status_code=500)
