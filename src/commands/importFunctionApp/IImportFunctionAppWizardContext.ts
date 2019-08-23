/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISubscriptionWizardContext } from "vscode-azureextensionui";

export interface IImportFunctionAppWizardContext extends ISubscriptionWizardContext {
    subscriptionId: string;
    functionAppId: string;
    functionAppName: string;
    functionAppTriggers: string[];
    functionAppRuntimeHost: string;
    apiId: string;
}
