import pytest
from interface_api.db import Database
from interface_api.repositories import Repository,identifier,now
from interface_api.artifact_validation import canonical
@pytest.fixture
def repo(tmp_path):
    db=Database(tmp_path/'data'/'test.sqlite3');db.migrate();return Repository(db)

def deployment(repo):return repo.create_deployment({'tenant_id':'demo','product_id':'desk','base_url':'http://127.0.0.1:4173','environment':'test','ui_variant':'standard'})
def run(repo,dep=None,**extra):
    dep=dep or deployment(repo)
    data={'run_id':identifier(),'kind':'discovery','purpose':'user','app_deployment_id':dep['app_deployment_id'],'deployment_snapshot_json':canonical({k:v for k,v in dep.items() if k not in ('created_at','updated_at')}),'selection_source':'discovery','task':'Look up member','inputs_json':'{}','status':'queued','created_at':now(),**extra}
    with repo.db.transaction() as c:repo.insert(c,'runs',data)
    return repo.get('runs','run_id',data['run_id'])
