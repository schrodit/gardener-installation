import { KubernetesObject } from "@kubernetes/client-node";
import { readFile } from "fs/promises";
import { createLogger } from "../log/Logger";
import { KeyValueState } from "../state/State";
import * as YAML from 'yaml';
import axios from 'axios';
import { retryWithBackoff } from "./exponentialBackoffRetry";
import { createOrUpdate, enrichKubernetesError } from "./kubernetes";
import { KubeClient } from "./KubeClient";

const log = createLogger('KubeApply');


export type ManagedResources = KubernetesObject;

export abstract class Manifest {

    constructor(public readonly name: string){}

    abstract getManifests(): Promise<KubernetesObject[]>;

    protected parseFile(content: string): KubernetesObject[] {
        
        const obj = YAML.parseAllDocuments(content);
        // todo: check if its a real obj;
        return obj.map(o => o.toJSON()) as KubernetesObject[];
    }
}


export class LocalManifest extends Manifest {
    constructor(name: string, public readonly path: string){
        super(name);
    }

    public async getManifests(): Promise<KubernetesObject[]> {
        return this.parseFile(await readFile(this.path, 'utf-8'));
    }
};

export class RemoteManifest extends Manifest {
    constructor(
        name: string,
        public readonly url: string,
    ){
        super(name);
    }

    public async getManifests(): Promise<KubernetesObject[]> {
        const res = await axios.get(this.url);
        return this.parseFile(res.data);
    }
}

export class RawManifest extends Manifest {
    private readonly manifests: KubernetesObject[];
    constructor(name: string, ...manifests: KubernetesObject[]){
        super(name);
        this.manifests = manifests;
    }

    public async getManifests(): Promise<KubernetesObject[]> {
        return this.manifests;
    }
};


/**
 * Applies raw kubernetes files
 */
export class KubeApply {
    constructor(
        private readonly kubeClient: KubeClient,
        private readonly state: KeyValueState<ManagedResources[]>,
        private readonly dryRun: boolean,
        private readonly defaultNamespace: string,
    ) {
    }

    public async apply(manifest: Manifest): Promise<void> {
        const manifests = await manifest.getManifests();

        this.state.store(manifest.name,
            await Promise.all(manifests.map(m => this.applyManifest(m)))
        )
    }

    private async applyManifest(manifest: KubernetesObject): Promise<KubernetesObject> {
        log.info(`Create manifest ${manifest.kind} ${manifest.metadata?.name}`);
        await retryWithBackoff(async (): Promise<boolean> => {
            const obj = this.getRawManifest(manifest);
            try {
                await createOrUpdate(this.kubeClient, this.getRawManifest(manifest),async () => {
                    Object.assign(obj, manifest);
                });
                return true;
            } catch (error) {
                log.error(enrichKubernetesError(manifest, error).message);
                return false;
            }
        });
        return this.getRawManifest(manifest);
    }

    private getRawManifest(manifest: KubernetesObject): KubernetesObject {
        return {
            apiVersion: manifest.apiVersion,
            kind: manifest.kind,
            metadata: {
                name: manifest.metadata?.name,
                namespace: manifest.metadata?.namespace,
            }
        }
    }
}