/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WebSiteManagementClient, WebSiteManagementModels } from "azure-arm-website";
import { ApiManagementClient, ApiManagementModels } from "azure-arm-apimanagement";
import { ServiceClientCredentials } from "ms-rest";
import { getResourceGroupFromId, getNameFromId } from "../utils/azure";
import { FunctionEnvelope } from "azure-arm-website/lib/models";
import { nonNullValue, nonNullProp } from "../utils/nonNull";

export class FunctionAppAsAPI {
    private readonly _webSiteClient: WebSiteManagementClient;
    private readonly _apiManagementClient: ApiManagementClient;

    constructor(
        credentials: ServiceClientCredentials,
        subscriptionId: string) {
        this._webSiteClient = new WebSiteManagementClient(credentials, subscriptionId);
        this._apiManagementClient = new ApiManagementClient(credentials, subscriptionId);
    }

    public static getBsonObjectId(): string {
        // tslint:disable-next-line:no-bitwise
        const timestamp = (new Date().getTime() / 1000 | 0).toString(16);

        // tslint:disable:typedef
        // tslint:disable-next-line:no-function-expression
        return timestamp + "xxxxxxxxxxxxxxxx".replace(/[x]/g, function () {
            // tslint:disable: no-bitwise
            // tslint:disable: insecure-random
            return (Math.random() * 16 | 0).toString(16);
        }).toLowerCase();
    }

    public static displayNameToIdentifier(value: string): string {
        const invalidIdCharsRegExp = new RegExp("[^A-Za-z0-9]", "ig");
        let identifier = value && value.replace(invalidIdCharsRegExp, "-").trim().replace(/-+/g, "-").substr(0, 80).replace(/(^-)|(-$)/g, "").toLowerCase();
        identifier = this.removeAccents(identifier);
        return identifier;
    }

    private static removeAccents(str: string): string {
        const accents = "ÀÁÂÃÄÅàáâãäåßÒÓÔÕÕÖØòóôõöøĎďDŽdžÈÉÊËèéêëðÇçČčÐÌÍÎÏìíîïÙÚÛÜùúûüĽĹľĺÑŇňñŔŕŠšŤťŸÝÿýŽž";
        const accentsOut = "AAAAAAaaaaaasOOOOOOOooooooDdDZdzEEEEeeeeeCcCcDIIIIiiiiUUUUuuuuLLllNNnnRrSsTtYYyyZz";
        const chars = str.split("");

        chars.forEach((letter, index) => {
            const i = accents.indexOf(letter);
            if (i !== -1) {
                chars[index] = accentsOut[i];
            }
        });

        return chars.join("");
    }

    private static parseUrlTemplate(uriTemplate: string): {
        parameters: ApiManagementModels.ParameterContract[],
        urlTemplate: string
    } {
        let cleanTemplate = "";
        const parameters: ApiManagementModels.ParameterContract[] = [];

        let templateStart = 0;
        let parameterStart = 0;
        let parameterDepth = 0;
        for (let i = 0; i < uriTemplate.length; i++) {
            if (uriTemplate[i] === "{") {
                if (parameterDepth === 0) {
                    parameterStart = i + 1;
                }
                parameterDepth++;
                cleanTemplate += uriTemplate.substring(templateStart, i);
                templateStart = i;
            } else if (uriTemplate[i] === "}" && --parameterDepth === 0) {
                if (parameterStart < i) {
                    const parameter = FunctionAppAsAPI._parseParameter(uriTemplate.substring(parameterStart, i));
                    cleanTemplate += `{${parameter.name}}`;
                    parameters.push(parameter);
                }
                templateStart = i + 1;
            }
        }

        cleanTemplate += uriTemplate.substring(templateStart);

        return {
            urlTemplate: cleanTemplate,
            parameters: parameters
        };
    }

    private static _parseParameter(param: string): ApiManagementModels.ParameterContract {
        const nameAndType = param.split(/:|=|\?/, 3);
        const defaultValue = param.split("=", 3);

        const parameter = <ApiManagementModels.ParameterContract>{
            name: nameAndType[0].startsWith("*") ? nameAndType[0].substr(1) : nameAndType[0],
            type: nameAndType.length > 1 ? FunctionAppAsAPI._mapParameterType(nameAndType[1]) : "",
            required: !param.endsWith("?")
        };

        if (defaultValue.length > 1) {
            parameter.defaultValue = defaultValue[1].endsWith("?") ? defaultValue[1].substr(0, defaultValue[1].length - 1) : defaultValue[1];
        }

        return parameter;
    }

    private static _mapParameterType(type: string): string {
        // Maps URI template constraint (https://docs.microsoft.com/en-us/aspnet/web-api/overview/web-api-routing-and-actions/attribute-routing-in-web-api-2#constraints)
        // to an OpenAPI parameter type (https://github.com/OAI/OpenAPI-Specification/blob/master/versions/2.0.md#parameterObject)
        // tslint:disable-next-line: switch-default
        switch (type) {
            case "alpha":
            case "datetime":
            case "guid":
                return "string";
            case "decimal":
            case "float":
            case "double":
                return "number";
            case "int":
            case "long":
                return "integer";
            case "bool":
                return "boolean";
        }

        if (type.startsWith("length(") || type.startsWith("maxlength(") || type.startsWith("minlength(") || type.startsWith("regex(")) {
            return "string";
        }

        if (type.startsWith("min(") || type.startsWith("max(") || type.startsWith("range(")) {
            return "integer";
        }

        return "";
    }

    public async importFunctionApp(funcAppId: string, funcAppName: string, funcAppTriggers: string[], apiId: string) : Promise<void> {
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

                if (binding.methods && binding.methods.length > 0) {
                    binding.methods.forEach(method => {
                        const operation = this.getNewOperation(apiId, method, FunctionAppAsAPI.displayNameToIdentifier(`${method}-${trigger}`), trigger);
                        const cleanUrl = FunctionAppAsAPI.parseUrlTemplate(route);
                        operation.urlTemplate = cleanUrl.urlTemplate;
                        operation.templateParameters = cleanUrl.parameters;
                        operations.push(operation);
                    });
                } else {
                    const operation = this.getNewOperation(apiId, "POST", FunctionAppAsAPI.displayNameToIdentifier(trigger), trigger);
                    const cleanUrl = FunctionAppAsAPI.parseUrlTemplate(route);
                    operation.urlTemplate = cleanUrl.urlTemplate;
                    operation.templateParameters = cleanUrl.parameters;
                    operations.push(operation);
                }

            }
        }
    }

    private async getFuncAppFunctions(functionAppId: string) : Promise<FunctionEnvelope[]> {
        const resourceGroupName = getResourceGroupFromId(functionAppId);
        const functionAppName = getNameFromId(functionAppId);

        let functions: FunctionEnvelope[] = [];
        let nextLink: string | undefined;
        do {
            const funcs: WebSiteManagementModels.FunctionEnvelopeCollection = nextLink ? await this._webSiteClient.webApps.listFunctions(resourceGroupName, functionAppName) : await this._webSiteClient.webApps.listFunctionsNext(nonNullValue(nextLink));
            nextLink = funcs.nextLink;
            functions = functions.concat(...funcs);

        } while (nextLink !== undefined);

        return functions;
    }

    private async getFuncAppToken(functionAppId: string): Promise<string> {
        const resourceGroupName = getResourceGroupFromId(functionAppId);
        const functionAppName = getNameFromId(functionAppId);
        return await this._webSiteClient.webApps.getFunctionsAdminToken(resourceGroupName, functionAppName);
    }

    private getNewOperation(apiId: string, method: string, operationId = FunctionAppAsAPI.getBsonObjectId(), displayName: string | undefined): ApiManagementModels.OperationContract {
        return {
            id : `${apiId}/operations/${operationId}`,
            name : operationId,
            displayName : displayName || operationId,
            method : method,
            description : "",
            urlTemplate : "*",
            templateParameters : []
        };
    }
}
