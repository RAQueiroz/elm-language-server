import path, * as Path from "path";
import { URI } from "vscode-uri";
import Parser, { Tree } from "web-tree-sitter";
import { IElmWorkspace } from "../../src/elmWorkspace";
import { Forest, IForest } from "../../src/forest";
import { Imports } from "../../src/imports";
import { container } from "tsyringe";
import { TypeCache } from "../../src/util/types/typeCache";
import {
  createTypeChecker,
  DefinitionResult,
  TypeChecker,
} from "../../src/util/types/typeChecker";
import { TreeUtils } from "../../src/util/treeUtils";
import {
  IPossibleImportsCache,
  PossibleImportsCache,
} from "../../src/util/possibleImportsCache";

export const baseUri = Path.join(__dirname, "../sources/src/");

export class MockElmWorkspace implements IElmWorkspace {
  private forest: IForest = new Forest([]);
  private parser: Parser;
  private typeCache = new TypeCache();
  private possibleImportsCache = new PossibleImportsCache();
  private operatorsCache = new Map<string, DefinitionResult>();

  constructor(sources: { [K: string]: string }) {
    this.parser = container.resolve("Parser");

    for (const key in sources) {
      if (Object.prototype.hasOwnProperty.call(sources, key)) {
        this.parseAndAddToForest(key, sources[key]);
      }
    }

    this.forest.treeMap.forEach((treeContainer) => {
      treeContainer.resolvedModules = this.resolveModules(treeContainer.tree);
    });

    this.forest.synchronize();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  init(progressCallback: (percent: number) => void): void {
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  hasDocument(uri: URI): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  hasPath(uri: URI): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getPath(uri: URI): string | undefined {
    return;
  }

  getForest(): IForest {
    return this.forest;
  }

  getRootPath(): URI {
    return URI.file(Path.join(__dirname, "sources"));
  }

  getTypeCache(): TypeCache {
    return this.typeCache;
  }

  getTypeChecker(): TypeChecker {
    return createTypeChecker(this);
  }

  markAsDirty(): void {
    return;
  }

  getPossibleImportsCache(): IPossibleImportsCache {
    return this.possibleImportsCache;
  }

  getOperatorsCache(): Map<string, DefinitionResult> {
    return this.operatorsCache;
  }

  private parseAndAddToForest(fileName: string, source: string): void {
    const tree: Tree | undefined = this.parser.parse(source);
    this.forest.setTree(
      URI.file(baseUri + fileName).toString(),
      true,
      true,
      tree,
      true,
    );
  }

  private resolveModules(tree: Tree): Map<string, string> {
    const importClauses = [
      ...Imports.getVirtualImports(),
      ...(TreeUtils.findAllImportClauseNodes(tree) ?? []),
    ];

    const resolvedModules = new Map<string, string>();

    // It should be faster to look directly at elmFolders instead of traversing the forest
    importClauses.forEach((importClause) => {
      const moduleName = TreeUtils.findFirstNamedChildOfType(
        "upper_case_qid",
        importClause,
      )?.text;

      if (moduleName) {
        const modulePath = moduleName.split(".").join("/") + ".elm";
        const uri = URI.file(path.join(baseUri, modulePath)).toString();
        const found = this.forest.getByUri(uri);

        if (!found) {
          // TODO: Diagnostics for unresolved imports
        } else {
          resolvedModules.set(moduleName, uri);
        }
      }
    });

    return resolvedModules;
  }
}
