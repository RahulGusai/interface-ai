import asyncio
from fastapi import APIRouter, Query, Request
from .dto import AppDeploymentDTO, CapabilityDTO, DeploymentCreate, DeploymentPatch, Page, BindingDTO
from .repositories import page
from .reads import Reads

router=APIRouter(prefix='/v1')


def repo(request):return request.app.state.repo


@router.get('/app-deployments',response_model=Page[AppDeploymentDTO])
async def deployments(request:Request,q:str='',environment:str|None=None,product_id:str|None=None,tenant_id:str|None=None,page_number:int=Query(1,alias='page',ge=1),page_size:int=Query(20,ge=1,le=100)):
    items=await asyncio.to_thread(repo(request).rows,'app_deployments')
    items=[x for x in items if all(value is None or x[field]==value for field,value in (('environment',environment),('product_id',product_id),('tenant_id',tenant_id))) and q.lower() in ' '.join(str(v) for v in x.values()).lower()]
    return page(items,page_size,page_number)


@router.post('/app-deployments',status_code=201,response_model=AppDeploymentDTO)
async def create_deployment(request:Request,body:DeploymentCreate):
    return await asyncio.to_thread(repo(request).create_deployment,body.model_dump())


@router.get('/app-deployments/{ident}',response_model=AppDeploymentDTO)
async def deployment(request:Request,ident:str):
    return await asyncio.to_thread(repo(request).get,'app_deployments','app_deployment_id',ident)


@router.patch('/app-deployments/{ident}',response_model=AppDeploymentDTO)
async def update_deployment(request:Request,ident:str,body:DeploymentPatch):
    patch=body.model_dump(exclude_unset=True);expected=patch.pop('expected_config_version')
    return await asyncio.to_thread(repo(request).update_deployment,ident,expected,patch)


@router.get('/app-deployments/{ident}/bindings')
async def deployment_bindings(request:Request,ident:str):
    await asyncio.to_thread(repo(request).get,'app_deployments','app_deployment_id',ident)
    read=Reads(repo(request))
    def load():
        items=[read.binding(x) for x in repo(request).rows('capability_bindings','app_deployment_id=?',(ident,))]
        return {'items':items,'pairs':[{'capability_id':c['capability_id'],'readiness':next((x['readiness'] for x in items if x['state']=='ready' and x['capability_id']==c['capability_id']),{'state':'discovery_needed','binding':None}), 'binding_id':next((x['binding_id'] for x in items if x['state']=='ready' and x['capability_id']==c['capability_id']),None)} for c in repo(request).rows('capabilities')]}
    return await asyncio.to_thread(load)


@router.get('/capabilities',response_model=Page[CapabilityDTO])
async def capabilities(request:Request,q:str='',page_number:int=Query(1,alias='page',ge=1),page_size:int=Query(20,ge=1,le=100)):
    items=await asyncio.to_thread(repo(request).rows,'capabilities')
    return page([Reads(repo(request)).capability(x) for x in items if q.lower() in (x['name']+' '+x['description']).lower()],page_size,page_number)


@router.get('/capabilities/{ident}')
async def capability(request:Request,ident:str):
    row=await asyncio.to_thread(repo(request).get,'capabilities','capability_id',ident)
    return await asyncio.to_thread(Reads(repo(request)).capability,row)


@router.get('/bindings',response_model=Page[BindingDTO])
async def bindings(request:Request,page_number:int=Query(1,alias='page',ge=1),page_size:int=Query(20,ge=1,le=100)):
    return await asyncio.to_thread(Reads(repo(request)).collection,'capability_bindings',{},page_number,page_size,projection=Reads(repo(request)).binding)
