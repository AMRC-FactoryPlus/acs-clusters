/*
 * Factory+ / AMRC Connectivity Stack (ACS) Edge Deployment operator
 * Main entry point
 * Copyright 2023 AMRC
 */

import stream from "stream";

import express from "express";

import { Debug, UUIDs } from "@amrc-factoryplus/utilities";

import { Checkout }         from "./checkout.js";
import { SealedSecrets }    from "./secrets.js";
import * as manifests       from "./manifests.js";
import { Git, Edge }        from "./uuids.js";

const FLUX_NS = "flux-system";

const debug = new Debug();

export class EdgeDeploy {
    constructor (opts) {
        this.fplus      = opts.fplus;
        this.http_url   = opts.http_url;
        this.group      = opts.repo_group;

        this.log = debug.log.bind(debug, "edge");
        this.routes = express.Router();

        this.secrets = new SealedSecrets(opts);
    }

    wrap (fn) {
        return async (req, res, next) => {
            try {
                return await fn.call(this, req, res, next);
            }
            catch (e) {
                next(e);
            }
        };
    }

    async init () {
        await this.fplus.Directory.register_service_url(
            Edge.Service.EdgeDeployment, this.http_url);

        const app = this.routes;
        app.post("/cluster", this.wrap(this.create_cluster));
        app.get("/cluster/:cluster/status", this.wrap(this.cluster_status));
        app.route("/cluster/:cluster/secret/:namespace/:name/:key")
            .put(this.wrap(this.seal_secret))
            .delete(this.wrap(this.delete_sealed_secret));

        return this;
    }

    async create_cluster (req, res) {
        const { name, sources } = req.body;

        const ok = await this.fplus.Auth.check_acl(
            req.auth, Edge.Perm.Clusters, UUIDs.Null, false);
        if (!ok) return res.status(403).end();

        const repo = await this.create_repo(name);
        const uuid = await this.create_cluster_objects(req.body, repo.url);
        await this.populate_cluster_repo(repo, req.body);

        return res.status(201).json({ uuid, flux: repo.url });
    }

    async cluster_has_git_creds (co) {
        /* Check every GitRepository has credentials */
        const repos = await co.list_manifests(FLUX_NS, "GitRepository");
        const secrets = await 
            Promise.all(repos.map(mani =>
                co.read_manifest(...mani)
                    .then(gitr => gitr.spec?.secretRef?.name)))
            .then(list => list.filter(i => i != null));
        
        for (const sname of secrets) {
            const sealed = await co.read_manifest(FLUX_NS, "SealedSecret", sname);
            if (!sealed) {
                this.log("No sealed secret %s", sname);
                return false;
            }
            const enc = sealed.spec.encryptedData;
            const creds = ("bearerToken" in enc) || ("username" in enc && "password" in enc);
            if (!creds) {
                this.log("Missing keys in secret %s, we have: %s", 
                    sname, Object.keys(enc).join(", "));
                return false;
            }
        }

        return true;
    }

    async cluster_status (req, res) {
        const { cluster } = req.params;

        const ok = await this.fplus.Auth.check_acl(
            req.auth, Edge.Perm.Clusters, cluster, true);
        if (!ok) return res.status(403).end();

        const info = await this.fplus.ConfigDB.get_config(Edge.App.Cluster, cluster);
        if (!info) return res.status(404).end();

        const co = await Checkout.clone({ fplus: this.fplus, url: info.flux });
        const ready = await this.cluster_has_git_creds(co);
        co.dispose();

        return res.status(200).json({ ready });
    }

    async create_repo (name) {
        const repo = `${this.group}/${name}`;
        this.log("Creating repo %s", repo);
        const res = await this.fplus.fetch({
            service:    Git.Service.Git,
            method:     "POST",
            url:        `/git/${repo}`,
        });
        if (res.status != 200)
            throw `Git: can't create repo ${repo}: ${res.status}`;
        return await res.json();
    }

    async create_cluster_objects (spec, repo) {
        const { name, kubeseal_cert } = spec;
        const namespace = spec.namespace ?? "fplus-edge";

        const cdb = this.fplus.ConfigDB;
        const uuid = await cdb.create_object(Edge.Class.Cluster);
        this.log("Created Edge Cluster %s", uuid);

        await cdb.put_config(UUIDs.App.Info, uuid, { name });
        await cdb.put_config(Edge.App.Cluster, uuid, {
            flux:           repo,
            namespace,
            kubeseal_cert,
        });

        return uuid;
    }

    async populate_cluster_repo (repo, spec) {
        this.log("Performing initial cluster deployment");
        const co = await Checkout.init({
            fplus:  this.fplus, 
            url:    repo.url,
        });
        await co.write_file("README.md", manifests.README);
        await co.commit("Add README.");
        await this.setup_repo_links(co, spec);
        await co.push();
        this.log("Pushed initial commits");
    }

    async setup_repo_links (co, spec) {
        if (!spec.sources) return;

        const git_base = await this.fplus.Discovery
            .service_url(Git.Service.Git);

        await this.write_sealed_secret(co, spec.kubeseal_cert, { 
            namespace:  FLUX_NS, 
            name:       "op1flux-secrets",
            key:        "username",
            content:    stream.Readable.from(`op1flux/${spec.name}`),
        });
        for (const source of spec.sources) {
            const name = source.replace("/", ".");
            const url = new URL(source, git_base).toString();

            this.log("Adding source %s", url);
            await co.write_manifest(manifests.git_repo(FLUX_NS, name, url));
            await co.write_manifest(manifests.flux_kust(FLUX_NS, name, name));
        }
        await co.commit("Written flux source manifests.");
    }

    async seal_secret (req, res) {
        const opts = { 
            ...req.params,
            content:    req, 
            dryrun:     "dryrun" in req.query,
        };
        
        const ok = await this.fplus.Auth.check_acl(
            req.auth, Edge.Perm.Secrets, opts.cluster, true);
        if (!ok) return res.status(403).end();

        const st = await this.secrets.seal_secret(opts);
        res.status(st).end();
    }

    async delete_sealed_secret (req, res) {
        const opts = {
            ...req.params,
            dryrun:         "dryrun" in req.query,
        }

        const ok = await this.fplus.Auth.check_acl(
            req.auth, Edge.Perm.Secrets, opts.cluster, true);
        if (!ok) return res.status(403).end();

        const st = await this.secrets.delete_secret(opts);
        res.status(st).end();
    }
}