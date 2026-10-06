from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
from interface_api.maintenance import backup,restore,orphan_keys
from conftest import deployment,run

def test_online_backup_restore_and_conservative_cleanup(repo,tmp_path):
    dep=deployment(repo);path=tmp_path/'backup.sqlite3';backup(repo.db,path)
    repo.update_deployment(dep['app_deployment_id'],1,{'ui_variant':'changed'});restore(repo.db,path)
    assert repo.get('app_deployments','app_deployment_id',dep['app_deployment_id'])['config_version']==1
    active=run(repo,dep);old=datetime.now(timezone.utc)-timedelta(days=2)
    objects=[SimpleNamespace(object_name=k,last_modified=date) for k,date in [('v1/runs/orphan/a.png',old),(f"v1/runs/{active['run_id']}/a.png",old),('other/orphan.png',old),('v1/runs/new/a.png',datetime.now(timezone.utc))]]
    assert list(orphan_keys(repo,objects))==['v1/runs/orphan/a.png']
