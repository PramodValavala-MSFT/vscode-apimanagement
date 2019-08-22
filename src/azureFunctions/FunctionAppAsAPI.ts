/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApiManagementClient, ApiManagementModels } from "azure-arm-apimanagement";
import { BackendCredentialsContract, PropertyContract, BackendContract } from "azure-arm-apimanagement/lib/models";
import { Backend } from "azure-arm-apimanagement/lib/operations";
import { WebSiteManagementClient, WebSiteManagementModels } from "azure-arm-website";
import { FunctionEnvelope } from "azure-arm-website/lib/models";
import { ServiceClientCredentials } from "ms-rest";
import { WebResource } from "ms-rest";
import * as request from 'request-promise';
import { appendExtensionUserAgent } from "vscode-azureextensionui";
import { getNameFromId, getResourceGroupFromId } from "../utils/azure";
import { nonNullValue } from "../utils/nonNull";
import { signRequest } from "../utils/signRequest";
import { FunctionHost, FunctionKey, FunctionKeys } from "./Contracts";
import { Utils } from "./Utils";

export class FunctionAppAsAPI {
    private readonly webSiteClient: WebSiteManagementClient;
    private readonly apiManagementClient: ApiManagementClient;

    constructor(
        private readonly credentials: ServiceClientCredentials,
        private readonly armEndpoint : string,
        subscriptionId: string) {
        this.webSiteClient = new WebSiteManagementClient(credentials, subscriptionId);
        this.apiManagementClient = new ApiManagementClient(credentials, subscriptionId);
    }

    public async importFunctionApp(funcAppId: string, funcAppName: string, funcAppTriggers: string[], apiId: string, runtimeHost: string): Promise<void> {
        if (funcAppTriggers === undefined || funcAppTriggers.length === 0) {
            return undefined;
        }

        const functions: FunctionEnvelope[] = await this.getFuncAppFunctions(funcAppId);
        const operations: ApiManagementModels.OperationContract[] = [];
        let functionConfigUrl: string | undefined;

        // tslint:disable-next-line: prefer-for-of
        for (let i = 0; i < funcAppTriggers.length; i++) {
            const trigger = funcAppTriggers[i];
            const triggerConfig = functions.find(f => f.name === trigger);
            if (triggerConfig) {
                functionConfigUrl = functionConfigUrl || triggerConfig.href;

                // tslint:disable-next-line: no-unsafe-any
                const binding = triggerConfig.config.bindings.find(b => !b.direction || b.direction === "in");
                const route = `/${binding.route || trigger}`;

                // tslint:disable: no-unsafe-any
                if (binding.methods && binding.methods.length > 0) {
                    binding.methods.forEach(method => {
                        const operation = this.getNewOperation(apiId, method, Utils.displayNameToIdentifier(`${method}-${trigger}`), trigger);
                        const cleanUrl = Utils.parseUrlTemplate(route);
                        operation.urlTemplate = cleanUrl.urlTemplate;
                        operation.templateParameters = cleanUrl.parameters;
                        operations.push(operation);
                    });
                } else {
                    const operation = this.getNewOperation(apiId, "POST", Utils.displayNameToIdentifier(trigger), trigger);
                    const cleanUrl = Utils.parseUrlTemplate(route);
                    operation.urlTemplate = cleanUrl.urlTemplate;
                    operation.templateParameters = cleanUrl.parameters;
                    operations.push(operation);
                }

            }
        }

        const propertyNames = [];
        if (operations.length > 0) {
            let appPrefix = "/api";

            const token = await this.getFuncAppToken(funcAppId);

            const funcAppToken = `Bearer ${token}`;
            const funcKey = await this.addFuncHostKey(apiId, runtimeHost, funcAppToken);

            if (functionConfigUrl) {
                const hostConfig = await this.getFuncAppHostConfig(functionConfigUrl);
                if (!hostConfig || !hostConfig.http || hostConfig.http.routePrefix === undefined) {
                    appPrefix = "/api";
                } else {
                    appPrefix = hostConfig.http.routePrefix === "" ? "" : `/${hostConfig.http.routePrefix}`;
                }
            }
            const appPath = `https://${runtimeHost}${appPrefix}`;
            const propertyId = Utils.displayNameToIdentifier(`${funcAppName}-key`);

            const serviceResourceGroupName = getResourceGroupFromId(apiId);
            const serviceName = getNameFromId(apiId);

            const securityProperty: PropertyContract = {
                displayName: propertyId,
                value: funcKey,
                tags: ["key", "function", "auto"],
                secret: true
            };

            await this.apiManagementClient.property.createOrUpdate(serviceResourceGroupName, serviceName, propertyId, securityProperty);

            const backendCredentials: BackendCredentialsContract  = {
                // tslint:disable-next-line:object-literal-key-quotes
                query: { "code": [`{{${securityProperty.name}}}`] }
            };

            const backendEntity = await this.setAppBackendEntity(funcAppId, appPath, apiId, backendCredentials);

            await this.apiManagementClient.apiOperation.listByApi()

            const checkOperations = await this.apiService.getOperations(apiId);
            const existingOperations = checkOperations.value;

            for (let i = 0; i < operations.length; i++) {
                const operation = operations[i];

                if (existingOperations.length > 0) {
                    Utils.amendOperationNameAndPath(operation, existingOperations);
                }

                await this.apiService.createOperation(operation);

                const requestPolicy = new RequestPolicy();
                requestPolicy.inboundPolicy.setChildPolicy(Utils.setApimGeneratedPolicyId(new SetBackendServicePolicy(null, backendEntity.name)));
                await this.policyService.setPolicyXmlForOperationScope(operation.id, requestPolicy.toXml());
            }
        }
    }

    private async setAppBackendEntity(appId: string, appPath: string, apiId: string, credentials?: BackendCredentialsContract): Promise<BackendContract> {
        const appName = getNameFromId(appId);
        const backendId = `FunctionApp_${Utils.displayNameToIdentifier(appName)}`;
        const backendEntity: BackendContract = {
            description: `${appName}`,
                url: appPath,
                protocol: "http",
                resourceId: `${this.armEndpoint}${appId}`,
                credentials: credentials
        };

        const serviceResourceGroupName = getResourceGroupFromId(apiId);
        const serviceName = getNameFromId(apiId);
        await this.apiManagementClient.backend.createOrUpdate(serviceResourceGroupName, serviceName, backendId, backendEntity);

        return backendEntity;
    }

    private async getFuncAppHostConfig(functionConfigUrl: string): Promise<FunctionHost> {
        let hostConfigUrl: string;
        const parts = functionConfigUrl.split("/functions/");
        if (parts.length === 2) {
            parts[1] = "config";
            hostConfigUrl = parts.join("/functions/");
        } else {
            throw new Error(`Unexpected function config url: ${functionConfigUrl}`);
        }

        const requestOptions: WebResource = new WebResource();
        requestOptions.headers = {
            ['User-Agent']: appendExtensionUserAgent(),
        };
        requestOptions.method = "GET";
        requestOptions.url = hostConfigUrl;

        await signRequest(requestOptions, this.credentials);

        // tslint:disable-next-line: await-promise
        const response = await request(requestOptions).promise();

        return JSON.parse(<string>(response));
    }

    private async addFuncHostKey(apiId: string, runtimeHost: string, funcAppToken: string): Promise<string> {
        const hostKeys = await this.getFuncHostKeys(runtimeHost, funcAppToken);
        const funcAppKeyName = await this.getServiceFuncKeyName(apiId);
        const existKey = hostKeys.keys.find(key => key.name === funcAppKeyName);
        if (existKey) {
            return existKey.value;
        }

        const newFuncKey = await this.createFuncHostKey(runtimeHost, funcAppKeyName, funcAppToken);

        return newFuncKey.value;
    }

    private async getServiceFuncKeyName(apiId: string): Promise<string> {
        const serviceName = getNameFromId(apiId);
        return `apim-${serviceName}`;
    }

    private async getFuncHostKeys(runtimeHost: string, funcAppToken: string): Promise<FunctionKeys> {
        const requestOptions: WebResource = new WebResource();
        requestOptions.headers = {
            ['User-Agent']: appendExtensionUserAgent(),
            ['Authorization']: funcAppToken
        };
        requestOptions.method = "GET";
        requestOptions.url = `https://${runtimeHost}/admin/host/keys`;
        // tslint:disable-next-line: await-promise
        const response = await request(requestOptions).promise();

        return JSON.parse(<string>(response));
    }

    private async createFuncHostKey(runtimeHost: string, funcKeyName: string, funcAppToken: string): Promise<FunctionKey> {
        const requestOptions: WebResource = new WebResource();
        requestOptions.headers = {
            ['User-Agent']: appendExtensionUserAgent(),
            ['Authorization']: funcAppToken
        };
        requestOptions.method = "POST";
        requestOptions.url = `https://${runtimeHost}/admin/host/keys/${funcKeyName}`;
        // tslint:disable-next-line: await-promise
        const response = await request(requestOptions).promise();

        return JSON.parse(<string>(response));
    }

    private async getFuncAppFunctions(functionAppId: string): Promise<FunctionEnvelope[]> {
        const resourceGroupName = getResourceGroupFromId(functionAppId);
        const functionAppName = getNameFromId(functionAppId);

        let functions: FunctionEnvelope[] = [];
        let nextLink: string | undefined;
        do {
            const funcs: WebSiteManagementModels.FunctionEnvelopeCollection = nextLink ? await this.webSiteClient.webApps.listFunctions(resourceGroupName, functionAppName) : await this.webSiteClient.webApps.listFunctionsNext(nonNullValue(nextLink));
            nextLink = funcs.nextLink;
            functions = functions.concat(...funcs);

        } while (nextLink !== undefined);

        return functions;
    }

    private async getFuncAppToken(functionAppId: string): Promise<string> {
        const resourceGroupName = getResourceGroupFromId(functionAppId);
        const functionAppName = getNameFromId(functionAppId);
        return await this.webSiteClient.webApps.getFunctionsAdminToken(resourceGroupName, functionAppName);
    }

    // tslint:disable-next-line:typedef
    private getNewOperation(apiId: string, method: string, operationId = Utils.getBsonObjectId(), displayName: string | undefined): ApiManagementModels.OperationContract {
        return {
            id: `${apiId}/operations/${operationId}`,
            name: operationId,
            displayName: displayName || operationId,
            method: method,
            description: "",
            urlTemplate: "*",
            templateParameters: []
        };
    }

    private getApiName(apiId: string): string | undefined {
        const nameRegex = /apis\/([^/]+)/;
        const nameMatches = nameRegex.exec(apiId);

        if (nameMatches && nameMatches.length > 1) {
            const name = nameMatches[1];
            return name;
        } else {
            return undefined;
        }
    }
}
