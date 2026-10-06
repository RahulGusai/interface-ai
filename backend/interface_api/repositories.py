import json
import math
from datetime import datetime, timezone
from uuid import uuid4
from .artifact_validation import canonical
from .errors import ApiError


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')


def identifier():
    return str(uuid4())


def decode(row):
    if row is None:return None
    return {k[:-5] if k.endswith('_json') else k:json.loads(v) if k.endswith('_json') and v is not None else v for k,v in dict(row).items()}


def page(items,page_size,page):
    total=len(items);page=min(page,max(1,math.ceil(total/page_size)))
    return {'items':items[(page-1)*page_size:page*page_size],'total':total,'page':page,'page_size':page_size}


class Repository:
    def __init__(self, db):self.db=db

    def get(self,table,key,value,conn=None):
        if table not in {'app_deployments','capabilities','runs','artifacts','capability_bindings','evidence_assets','artifact_assets'}:raise ValueError('Invalid table')
        if key not in {'app_deployment_id','capability_id','run_id','artifact_id','binding_id','asset_id','idempotency_key'}:raise ValueError('Invalid key')
        if conn is not None:row=conn.execute(f'SELECT * FROM {table} WHERE {key}=?',(value,)).fetchone()
        else:
            with self.db.connect() as c:row=c.execute(f'SELECT * FROM {table} WHERE {key}=?',(value,)).fetchone()
        if row is None:raise ApiError(404,'NOT_FOUND','Requested resource was not found')
        return decode(row)

    def rows(self,table,where='',params=(),order='created_at DESC',conn=None):
        allowed={'app_deployments','capabilities','runs','artifacts','capability_bindings','evidence_assets','artifact_assets','run_events'}
        if table not in allowed:raise ValueError('Invalid table')
        query=f'SELECT * FROM {table}'+(f' WHERE {where}' if where else '')+(f' ORDER BY {order}' if order else '')
        if conn is not None:return [decode(x) for x in conn.execute(query,params)]
        with self.db.connect() as c:return [decode(x) for x in c.execute(query,params)]

    def insert(self,conn,table,values):
        fields=','.join(values);placeholders=','.join('?' for _ in values)
        conn.execute(f'INSERT INTO {table} ({fields}) VALUES ({placeholders})',tuple(values.values()))

    def create_deployment(self,request):
        stamp=now();data={**request,'app_deployment_id':identifier(),'config_version':1,'created_at':stamp,'updated_at':stamp}
        data.setdefault('vendor_release',None)
        with self.db.transaction() as c:self.insert(c,'app_deployments',data)
        return data

    def update_deployment(self,ident,expected,patch):
        with self.db.transaction() as c:
            current=self.get('app_deployments','app_deployment_id',ident,c)
            if current['config_version']!=expected:raise ApiError(409,'CONFIG_VERSION_CONFLICT','Deployment configuration changed')
            current.update(patch);current['config_version']+=1;current['updated_at']=now()
            c.execute('UPDATE app_deployments SET base_url=?,environment=?,ui_variant=?,vendor_release=?,config_version=?,updated_at=? WHERE app_deployment_id=?',tuple(current[x] for x in ('base_url','environment','ui_variant','vendor_release','config_version','updated_at','app_deployment_id')))
            return current

    def event(self,run_id,type,payload=None,step_id=None,assets=(),conn=None):
        if conn is None:
            with self.db.transaction() as c:return self.event(run_id,type,payload,step_id,assets,c)
        run=self.get('runs','run_id',run_id,conn);seq=run['last_event_sequence']+1;stamp=now()
        self.insert(conn,'run_events',{'run_id':run_id,'sequence':seq,'timestamp':stamp,'type':type,'step_id':step_id,'payload_json':canonical(payload or {})})
        for asset in assets:self.insert(conn,'evidence_assets',{**asset,'run_id':run_id,'event_sequence':seq})
        conn.execute('UPDATE runs SET last_event_sequence=? WHERE run_id=?',(seq,run_id))
        return {'run_id':run_id,'sequence':seq,'timestamp':stamp,'type':type,'step_id':step_id,'payload':payload or {}}
