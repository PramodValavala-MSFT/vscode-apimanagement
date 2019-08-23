/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AzureWizardPromptStep } from "vscode-azureextensionui";
import { IImportFunctionAppWizardContext } from "./IImportFunctionAppWizardContext";

export class FunctionAppListStep extends AzureWizardPromptStep<IImportFunctionAppWizardContext> {
    public async prompt(wizardContext: IImportFunctionAppWizardContext): Promise<void> {
       
    }

    public shouldPrompt(wizardContext: IImportFunctionAppWizardContext): boolean {
        return !wizardContext.functionAppId;
    }
}
